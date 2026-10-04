import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as dns from 'dns';
import * as net from 'net';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(Webhook)
    private webhooksRepo: Repository<Webhook>,
    private webhookDelivery: WebhookDeliveryService,
  ) {}

  async dispatch(merchantId: string, event: string, payload: Record<string, any>): Promise<void> {
    const webhooks = await this.webhooksRepo.find({
      where: { merchantId, isActive: true },
    });

    const matchingWebhooks = webhooks.filter(
      (w) => w.events.includes(event) || w.events.includes('*'),
    );

    const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });

    for (const webhook of matchingWebhooks) {
      await this.webhookDelivery.enqueueDelivery(webhook, event, body);
      this.logger.log(`Webhook delivery enqueued: webhookId=${webhook.id} event=${event}`);
    }
  }

  async create(merchantId: string, url: string, events: string[], secret?: string) {
    await this.assertPublicUrl(url);

    const webhook = this.webhooksRepo.create({
      merchantId,
      url,
      events,
      secret: secret ?? crypto.randomBytes(24).toString('hex'),
    });
    return this.webhooksRepo.save(webhook);
  }

  async findAll(merchantId: string) {
    return this.webhooksRepo.find({ where: { merchantId } });
  }

  async remove(id: string, merchantId: string) {
    const webhook = await this.webhooksRepo.findOne({ where: { id, merchantId } });
    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }
    await this.webhooksRepo.remove(webhook);
    return webhook;
  }

  /**
   * Resolves the webhook hostname and rejects private, loopback, and
   * link-local IP ranges to prevent SSRF against internal infrastructure.
   */
  private async assertPublicUrl(url: string): Promise<void> {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new BadRequestException('Webhook URL is not a valid URL');
    }

    const addresses: string[] = [];
    if (net.isIP(hostname)) {
      addresses.push(hostname);
    } else {
      try {
        const resolved = await dns.promises.lookup(hostname, { all: true });
        addresses.push(...resolved.map((r) => r.address));
      } catch {
        throw new BadRequestException(`Webhook URL host could not be resolved: ${hostname}`);
      }
    }

    for (const address of addresses) {
      if (this.isPrivateAddress(address)) {
        throw new BadRequestException(
          `Webhook URL resolves to a private or reserved address: ${address}`,
        );
      }
    }
  }

  private isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
      const [a, b] = address.split('.').map((part) => parseInt(part, 10));
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a >= 224) return true;
      return false;
    }

    if (net.isIPv6(address)) {
      const normalized = address.toLowerCase();
      if (normalized === '::1' || normalized === '::') return true;
      if (normalized.startsWith('fe80:')) return true;
      if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
      if (normalized.startsWith('::ffff:')) {
        return this.isPrivateAddress(normalized.slice('::ffff:'.length));
      }
      return false;
    }

    return true;
  }
}
