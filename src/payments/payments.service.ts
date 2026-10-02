import { Injectable, NotFoundException, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as QRCode from 'qrcode';
import * as StellarSdk from '@stellar/stellar-sdk';
import Big from 'big.js';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { BatchCreatePaymentDto, BatchPaymentResultDto } from './dto/batch-create-payment.dto';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MerchantsService } from '../merchants/merchants.service';
import { PaginatedResponseDto } from '../common/dto/pagination.dto';
import { PaymentEscrowService, PaymentExpiredError } from '../blockchain-wallet/payment-escrow.service';
import { AnalyticsService } from '../analytics/analytics.service';

// Events emitted per payment in a batch — mirrors contract PaymentCreated events
export interface PaymentCreatedEvent {
  type: 'PaymentCreated';
  paymentId: string;
  merchantId: string;
  amountUsd: string;
  memo: string;
  timestamp: Date;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private paymentsRepo: Repository<Payment>,
    private stellar: StellarService,
    private webhooks: WebhooksService,
    private notifications: NotificationsService,
    private merchants: MerchantsService,
    private soroban: PaymentEscrowService,
    private analytics: AnalyticsService,
    private dataSource: DataSource,
  ) {}

  /**
   * Resolve the XLM/USD rate for customer-facing payment creation.
   *
   * getXlmUsdRate() now returns { rate, isFallback }. A fallback rate is a
   * fabricated/stale constant and must never be used to quote a deposit
   * amount, so we refuse the request instead of mispricing the payment.
   */
  private async resolveXlmRate(): Promise<number> {
    const { rate, isFallback } = await this.stellar.getXlmUsdRate();
    if (isFallback) {
      this.logger.error(
        'XLM/USD rate unavailable (Horizon failure or empty orderbook); refusing to quote a payment with a fallback rate',
      );
      throw new ServiceUnavailableException(
        'Unable to fetch a live XLM/USD exchange rate. Please try again shortly.',
      );
    }
    return rate;
  }

  async create(merchantId: string, dto: CreatePaymentDto): Promise<Payment> {
    const xlmRate = await this.resolveXlmRate();
    const amountXlm = new Big(dto.amountUsd).div(xlmRate);

    const memo = this.stellar.generateMemo();
    const depositAddress = this.stellar.getDepositAddress();

    const stellarUri = `web+stellar:pay?destination=${depositAddress}&amount=${amountXlm.toFixed(7)}&memo=${memo}&memo_type=text`;
    const qrCode = await QRCode.toDataURL(stellarUri);

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + (dto.expiryMinutes ?? 30));

    const payment = this.paymentsRepo.create({
      id: uuidv4(),
      reference: `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      merchantId,
      amountUsd: String(dto.amountUsd),
      amountXlm: amountXlm.toFixed(7),
      description: dto.description,
      customerEmail: dto.customerEmail,
      metadata: dto.metadata,
      stellarDepositAddress: depositAddress,
      stellarMemo: memo,
      qrCode,
      expiresAt,
      status: PaymentStatus.PENDING,
    });

    const saved = await this.paymentsRepo.save(payment);

    // Register in Soroban contract with ledger-based expiry.
    // expiryLedgers defaults to 360 (≈ 30 min at 1 ledger/5 s).
    const expiryLedgers = (dto.expiryMinutes ?? 30) * PaymentEscrowService.LEDGERS_PER_MINUTE;
    const contractPayment = this.soroban.createPayment(
      saved.id,
      depositAddress,
      '0', // amountUsdc populated on confirmation
      expiryLedgers,
    );

    // Persist the expiry_ledger so NestJS cron can query it without RPC calls.
    saved.expiryLedger = contractPayment.expiryLedger;
    return this.paymentsRepo.save(saved);
  }

  /**
   * Confirm a payment — delegates to the Soroban contract which enforces
   * ledger-based expiry. Throws PaymentExpiredError (→ 410) if the payment
   * window has passed, regardless of NestJS state.
   */
  async confirmPayment(
    paymentId: string,
    customerAddress: string,
  ): Promise<Payment> {
    const payment = await this.paymentsRepo.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    // Contract enforces expiry — this throws PaymentExpiredError if expired.
    try {
      await this.soroban.confirm(paymentId, customerAddress);
    } catch (err) {
      if (err instanceof PaymentExpiredError) {
        // Sync NestJS state with contract state
        payment.status = PaymentStatus.EXPIRED;
        await this.paymentsRepo.save(payment);
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    payment.status = PaymentStatus.CONFIRMED;
    payment.customerWalletAddress = customerAddress;
    payment.confirmedAt = new Date();
    const saved = await this.paymentsRepo.save(payment);

    // Invalidate merchant analytics caches since funnel and comparison data may have changed.
    this.analytics.clearCacheForMerchant(payment.merchantId);

    return saved;
  }

  async applySorobanPaymentConfirmed(event: { paymentReference: string; txHash?: string; amount?: number; asset?: string; from?: string }): Promise<void> {
    const payment = await this.paymentsRepo.findOne({ where: { id: event.paymentReference } });
    if (!payment) {
      this.logger.warn(`Soroban payment confirmed for unknown payment ${event.paymentReference}`);
      return;
    }

    if (payment.status === PaymentStatus.CONFIRMED) {
      return;
    }

    payment.status = PaymentStatus.CONFIRMED;
    payment.confirmedAt = new Date();
    if (event.txHash) payment.txHash = event.txHash;
    if (event.from) payment.customerWalletAddress = event.from;
    await this.paymentsRepo.save(payment);

    this.analytics.clearCacheForMerchant(payment.merchantId);
  }

  /**
   * create_batch — mirrors the Soroban contract's create_batch(payments: Vec<PaymentInput>).
   *
   * Creates up to 20 payment requests atomically. Validates every entry first
   * so the entire batch reverts (throws) if any single input is invalid —
   * no partial writes ever reach the database.
   *
   * Emits a PaymentCreated event for each entry, matching the contract event log.
   */
  async createBatch(
    merchantId: string,
    dto: BatchCreatePaymentDto,
  ): Promise<BatchPaymentResultDto> {
    const { payments: items } = dto;

    // ── Validate all inputs before touching the DB (atomic revert on failure) ──
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.amountUsd || item.amountUsd <= 0) {
        throw new BadRequestException(
          `Batch item [${i}]: amountUsd must be greater than 0`,
        );
      }
      if (!item.memo || item.memo.trim().length === 0) {
        throw new BadRequestException(
          `Batch item [${i}]: memo must not be empty`,
        );
      }
    }

    // ── Build all payment records in memory ───────────────────────────────────
    const xlmRate = await this.resolveXlmRate();
    const depositAddress = this.stellar.getDepositAddress();
    const now = Date.now();

    const records: Payment[] = [];
    const events: PaymentCreatedEvent[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const amountXlm = new Big(item.amountUsd).div(xlmRate);

      const memo = this.stellar.generateMemo();
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + (item.expiryMinutes ?? 30));

      const record = this.paymentsRepo.create({
        id: uuidv4(),
        reference: `PAY-${now}-${i}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        merchantId,
        amountUsd: String(item.amountUsd),
        amountXlm: amountXlm.toFixed(7),
        description: item.memo,
        customerEmail: item.customerEmail,
        metadata: item.metadata,
        stellarDepositAddress: depositAddress,
        stellarMemo: memo,
        expiresAt,
        status: PaymentStatus.PENDING,
      });

      records.push(record);
      events.push({
        type: 'PaymentCreated',
        paymentId: record.id,
        merchantId,
        amountUsd: String(item.amountUsd),
        memo,
        timestamp: new Date(),
      });
    }

    // ── Persist the whole batch in a single transaction ───────────────────────
    const saved = await this.dataSource.transaction(async (manager) => {
      return manager.save(Payment, records);
    });

    this.logger.log(
      `Batch created ${saved.length} payments for merchant ${merchantId}`,
    );

    return {
      payments: saved.map((p) => ({
        id: p.id,
        reference: p.reference,
        amountUsd: p.amountUsd,
        amountXlm: p.amountXlm,
        stellarDepositAddress: p.stellarDepositAddress,
        stellarMemo: p.stellarMemo,
        expiresAt: p.expiresAt,
      })),
      events,
    };
  }

  async refund(
    merchantId: string,
    paymentId: string,
    dto: RefundPaymentDto,
  ): Promise<Payment> {
    const payment = await this.findOne(merchantId, paymentId);
    if (!payment) throw new NotFoundException('Payment not found');

    if (payment.status !== PaymentStatus.CONFIRMED) {
      throw new BadRequestException('Only confirmed payments can be refunded');
    }

    if (!payment.customerWalletAddress) {
      throw new BadRequestException('Payment has no customer wallet address');
    }

    const alreadyRefundedUsd = new Big(payment.refundAmountUsd ?? '0');
    const remainingUsd = new Big(payment.amountUsd).minus(alreadyRefundedUsd);
    const refundAmount = new Big(dto.amountUsd);

    if (refundAmount.gt(remainingUsd)) {
      throw new BadRequestException(
        `Refund amount exceeds remaining refundable balance of ${remainingUsd.toFixed(6)}`,
      );
    }

    const newRefundedUsd = alreadyRefundedUsd.plus(refundAmount);
    payment.refundAmountUsd = newRefundedUsd.toFixed(6);
    payment.status =
      newRefundedUsd.gte(new Big(payment.amountUsd))
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;
    payment.refundReason = dto.reason;
    payment.refundedAt = new Date();

    const saved2 = await this.paymentsRepo.save(payment);

    this.analytics.clearCacheForMerchant(payment.merchantId);

    return saved2;
  }

  async findAll(
    merchantId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponseDto<Payment>> {
    const [items, total] = await this.paymentsRepo.findAndCount({
      where: { merchantId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, merchantId: string): Promise<Payment> {
    const payment = await this.paymentsRepo.findOne({ where: { id, merchantId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * Lookup backing the unauthenticated GET /pay/:reference page. Deliberately
   * un-scoped by merchant: the reference is the only credential the customer
   * has, and the caller maps the result to PublicPaymentViewDto which drops
   * every merchant-identifying and PII field.
   */
  async findByReference(reference: string): Promise<Payment> {
    const payment = await this.paymentsRepo.findOne({ where: { reference } });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async getStats(merchantId: string) {
    return this.paymentsRepo
      .createQueryBuilder('payment')
      .select('payment.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('SUM(payment.amountUsd)', 'totalUsd')
      .where('payment.merchantId = :merchantId', { merchantId })
      .groupBy('payment.status')
      .getRawMany();
  }
}
