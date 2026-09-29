import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bull';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { DateRange, addUtcDays, resolveDateRange } from '../common/date-range.util';
import { EmailService } from '../email/email.service';
import { Merchant, MerchantRole } from '../merchants/entities/merchant.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { Settlement, SettlementStatus } from '../settlements/entities/settlement.entity';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsExport,
  AnalyticsExportFormat,
  AnalyticsExportScope,
  AnalyticsExportStatus,
} from './entities/analytics-export.entity';

export const ANALYTICS_EXPORT_QUEUE = 'analytics-export';

type AnalyticsPeriod = 'daily' | 'monthly';

interface RequestExportOptions {
  requesterId: string;
  requesterRole: MerchantRole;
  format: string;
  period: AnalyticsPeriod;
  dateFrom?: string;
  dateTo?: string;
  deliveryBaseUrl: string;
}

interface ExportMetrics {
  period: AnalyticsPeriod;
  periodLabel: string;
  merchantName: string;
  volumeSeries: Array<{ date: string; count: number; volumeUsd: number }>;
  totalVolumeUsd: number;
  paymentCount: number;
  averagePaymentValueUsd: number;
  highestVolumeBucket: { date: string; volumeUsd: number };
  averageBucketVolumeUsd: number;
  settlementSummary: {
    count: number;
    grossUsd: number;
    netUsd: number;
    feesUsd: number;
  };
  topMetrics: Array<{ label: string; value: string }>;
}

@Injectable()
export class AnalyticsExportService {
  private readonly logger = new Logger(AnalyticsExportService.name);

  constructor(
    @InjectRepository(AnalyticsExport)
    private readonly exportRepo: Repository<AnalyticsExport>,
    @InjectRepository(Merchant)
    private readonly merchantsRepo: Repository<Merchant>,
    @InjectRepository(Payment)
    private readonly paymentsRepo: Repository<Payment>,
    @InjectRepository(Settlement)
    private readonly settlementsRepo: Repository<Settlement>,
    @InjectQueue(ANALYTICS_EXPORT_QUEUE)
    private readonly exportQueue: Queue<{ exportId: string }>,
    private readonly analyticsService: AnalyticsService,
    private readonly emailService: EmailService,
  ) {}

  async requestExport(options: RequestExportOptions) {
    const { requesterId, requesterRole, format, period, dateFrom, dateTo, deliveryBaseUrl } =
      options;

    if (format !== AnalyticsExportFormat.PDF) {
      throw new BadRequestException('Only pdf exports are supported');
    }

    const requester = await this.merchantsRepo.findOne({ where: { id: requesterId } });
    if (!requester) {
      throw new NotFoundException('Merchant not found');
    }

    const scope =
      requesterRole === MerchantRole.ADMIN || requesterRole === MerchantRole.SUPERADMIN
        ? AnalyticsExportScope.ADMIN
        : AnalyticsExportScope.MERCHANT;

    const exportRecord = await this.exportRepo.save(
      this.exportRepo.create({
        format: AnalyticsExportFormat.PDF,
        scope,
        status: AnalyticsExportStatus.QUEUED,
        requestedByMerchantId: requester.id,
        merchantId: scope === AnalyticsExportScope.MERCHANT ? requester.id : null,
        recipientEmail: requester.email,
        merchantBusinessName: requester.businessName,
        period,
        dateFrom: dateFrom ?? null,
        dateTo: dateTo ?? null,
        deliveryBaseUrl: deliveryBaseUrl.replace(/\/$/, ''),
        fileName: null,
        fileData: null,
        downloadToken: null,
        expiresAt: null,
        errorMessage: null,
      }),
    );

    await this.exportQueue.add(
      'generate',
      { exportId: exportRecord.id },
      { removeOnComplete: true, removeOnFail: false },
    );

    return {
      exportId: exportRecord.id,
      status: exportRecord.status,
      message: 'Analytics export queued',
    };
  }

  async generateExport(exportId: string): Promise<void> {
    const exportRecord = await this.exportRepo.findOne({ where: { id: exportId } });
    if (!exportRecord) {
      this.logger.warn(`Analytics export not found: ${exportId}`);
      return;
    }

    exportRecord.status = AnalyticsExportStatus.PROCESSING;
    exportRecord.errorMessage = null;
    await this.exportRepo.save(exportRecord);

    try {
      const metrics = await this.buildMetrics(exportRecord);
      const buffer = await this.buildPdf(metrics);
      const token = randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fileName = this.buildFileName(exportRecord, metrics);

      exportRecord.fileName = fileName;
      exportRecord.fileData = buffer;
      exportRecord.downloadToken = token;
      exportRecord.expiresAt = expiresAt;
      exportRecord.status = AnalyticsExportStatus.READY;
      await this.exportRepo.save(exportRecord);

      await this.emailService.queue(
        exportRecord.recipientEmail,
        'analytics-report-ready',
        {
          merchantName: exportRecord.merchantBusinessName,
          reportName: fileName,
          downloadUrl: `${exportRecord.deliveryBaseUrl}/export/download/${token}`,
          expiresAt: expiresAt.toISOString(),
        },
        exportRecord.requestedByMerchantId,
      );
    } catch (error) {
      exportRecord.status = AnalyticsExportStatus.FAILED;
      exportRecord.errorMessage = error instanceof Error ? error.message : String(error);
      await this.exportRepo.save(exportRecord);
      throw error;
    }
  }

  async getDownloadByToken(token: string): Promise<AnalyticsExport> {
    const exportRecord = await this.exportRepo.findOne({
      where: { downloadToken: token },
    });

    if (!exportRecord || !exportRecord.fileData || exportRecord.status !== AnalyticsExportStatus.READY) {
      throw new NotFoundException('Analytics export not found');
    }

    if (exportRecord.expiresAt && exportRecord.expiresAt.getTime() < Date.now()) {
      throw new GoneException('Download link expired');
    }

    return exportRecord;
  }

  private async buildMetrics(exportRecord: AnalyticsExport): Promise<ExportMetrics> {
    const period = exportRecord.period;
    const merchantName = exportRecord.merchantBusinessName;
    const volumeSeries = await this.analyticsService.getVolume({
      scope:
        exportRecord.scope === AnalyticsExportScope.ADMIN ? 'admin' : 'merchant',
      merchantId: exportRecord.merchantId ?? undefined,
      period,
      dateFrom: exportRecord.dateFrom ?? undefined,
      dateTo: exportRecord.dateTo ?? undefined,
    });

    const totalVolumeUsd = volumeSeries.reduce((sum, item) => sum + item.volumeUsd, 0);
    const paymentCount = volumeSeries.reduce((sum, item) => sum + item.count, 0);
    const averagePaymentValueUsd = paymentCount > 0 ? totalVolumeUsd / paymentCount : 0;
    const highestVolumeBucket = volumeSeries.reduce(
      (best, item) => (item.volumeUsd > best.volumeUsd ? item : best),
      volumeSeries[0] ?? { date: 'N/A', count: 0, volumeUsd: 0 },
    );
    const averageBucketVolumeUsd =
      volumeSeries.length > 0 ? totalVolumeUsd / volumeSeries.length : 0;

    const range = resolveDateRange(
      period,
      exportRecord.dateFrom ?? undefined,
      exportRecord.dateTo ?? undefined,
    );
    const settlementSummary = await this.getSettlementSummary(exportRecord, range);
    const periodLabel =
      volumeSeries.length > 0
        ? `${volumeSeries[0].date} to ${volumeSeries[volumeSeries.length - 1].date}`
        : `${this.formatRangeLabel(range.start, period)} to ${this.formatRangeLabel(
            this.previousMoment(range.endExclusive, period),
            period,
          )}`;

    return {
      period,
      periodLabel,
      merchantName,
      volumeSeries,
      totalVolumeUsd,
      paymentCount,
      averagePaymentValueUsd,
      highestVolumeBucket,
      averageBucketVolumeUsd,
      settlementSummary,
      topMetrics: [
        { label: 'Total Volume (USD)', value: this.formatCurrency(totalVolumeUsd) },
        { label: 'Payments', value: paymentCount.toLocaleString('en-US') },
        { label: 'Average Payment (USD)', value: this.formatCurrency(averagePaymentValueUsd) },
        { label: 'Highest Volume Day', value: `${highestVolumeBucket.date} (${this.formatCurrency(highestVolumeBucket.volumeUsd)})` },
        { label: 'Average Daily Volume (USD)', value: this.formatCurrency(averageBucketVolumeUsd) },
        { label: 'Settlements', value: settlementSummary.count.toLocaleString('en-US') },
        { label: 'Settled Gross (USD)', value: this.formatCurrency(settlementSummary.grossUsd) },
        { label: 'Settled Net (USD)', value: this.formatCurrency(settlementSummary.netUsd) },
        { label: 'Settlement Fees (USD)', value: this.formatCurrency(settlementSummary.feesUsd) },
      ],
    };
  }

  private async getSettlementSummary(
    exportRecord: AnalyticsExport,
    range: DateRange,
  ): Promise<ExportMetrics['settlementSummary']> {
    const qb = this.settlementsRepo
      .createQueryBuilder('settlement')
      .where('settlement.createdAt >= :start', { start: range.start })
      .andWhere('settlement.createdAt < :end', { end: range.endExclusive })
      .andWhere('settlement.status = :status', { status: SettlementStatus.COMPLETED });

    if (exportRecord.scope === AnalyticsExportScope.MERCHANT && exportRecord.merchantId) {
      qb.andWhere('settlement.merchantId = :merchantId', {
        merchantId: exportRecord.merchantId,
      });
    }

    const settlements = await qb.getMany();
    return settlements.reduce(
      (summary, settlement) => {
        summary.count += 1;
        summary.grossUsd += Number(settlement.grossAmount ?? 0);
        summary.netUsd += Number(settlement.netAmount ?? 0);
        summary.feesUsd += Number(settlement.feeAmount ?? 0);
        return summary;
      },
      { count: 0, grossUsd: 0, netUsd: 0, feesUsd: 0 },
    );
  }

  private resolveRange(
    period: AnalyticsPeriod,
    dateFrom?: string,
    dateTo?: string,
  ): TimeRange {
    const end = dateTo ? new Date(dateTo) : new Date();
    const start = dateFrom
      ? new Date(dateFrom)
      : new Date(end.getTime() - (period === 'monthly' ? 365 : 30) * 24 * 60 * 60 * 1000);

    return { start, endExclusive: new Date(end.getTime() + 24 * 60 * 60 * 1000) };
  }

  private previousMoment(date: Date, period: AnalyticsPeriod): Date {
    const previous = new Date(date);
    previous.setDate(previous.getDate() - (period === 'monthly' ? 30 : 1));
    return previous;
  }

  private formatRangeLabel(date: Date, period: AnalyticsPeriod): string {
    return period === 'monthly'
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      : date.toISOString().slice(0, 10);
  }

  private formatCurrency(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  private buildFileName(exportRecord: AnalyticsExport, metrics: ExportMetrics): string {
    const safeName = metrics.merchantName
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safeName || 'analytics'}-${metrics.period}-${stamp}.pdf`;
  }

  private async buildPdf(metrics: ExportMetrics): Promise<Buffer> {
    const lines: string[] = [];
    const text = (x: number, y: number, size: number, value: string) => {
      lines.push(
        `BT /F1 ${size} Tf ${x} ${y} Td (${this.escapePdfText(value)}) Tj ET`,
      );
    };

    text(40, 555, 22, `${metrics.merchantName} Analytics Report`);
    text(40, 530, 12, `Period: ${metrics.periodLabel}`);

    let cursor = 495;
    for (const metric of metrics.topMetrics) {
      text(40, cursor, 12, `${metric.label}: ${metric.value}`);
      cursor -= 20;
    }

    const content = lines.join('\n');
    const objects: string[] = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    );
    objects.push(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i += 1) {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (const offset of offsets) {
      pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(pdf, 'latin1');
  }

  private escapePdfText(value: string): string {
    return value
      .replace(/[\u0080-\u00FF]/g, (char) => {
        const code = char.charCodeAt(0);
        return `\\${code.toString(8).padStart(3, '0')}`;
      })
      .replace(/[^\x20-\x7E]/g, '?')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  private formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  private previousMoment(value: Date, period: AnalyticsPeriod): Date {
    return period === 'daily' ? addUtcDays(value, -1) : addUtcDays(value, -1);
  }

  private formatRangeLabel(value: Date, period: AnalyticsPeriod): string {
    return period === 'daily'
      ? value.toISOString().slice(0, 10)
      : value.toISOString().slice(0, 7);
  }
}
