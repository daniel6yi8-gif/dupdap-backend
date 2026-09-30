jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
// The controller spec exercises request/response wiring only. PaymentsService is
// mocked at the module level so the spec does not depend on the service's
// repository/TypeORM internals.
jest.mock('./payments.service', () => ({
  PaymentsService: class PaymentsService {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController, PublicPaymentController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { CacheService } from '../cache/cache.service';
import { PaymentNetwork, PaymentStatus } from './entities/payment.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { BatchCreatePaymentDto } from './dto/batch-create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { PublicPaymentViewDto } from './dto/public-payment-view.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

const REQ = { user: { merchantId: 'm1' } };

function mockPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    merchantId: 'm1',
    reference: 'PAY-abc123',
    amountUsd: '100.000000',
    amountXlm: '50.0000000',
    amountUsdc: null,
    currency: null,
    network: PaymentNetwork.STELLAR,
    status: PaymentStatus.PENDING,
    stellarDepositAddress: 'GABC',
    stellarMemo: 'memo-1',
    description: 'Order #1',
    qrCode: 'data:image/png;base64,AAA',
    expiresAt: new Date('2026-01-01T00:30:00.000Z'),
    expiryLedger: 360,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as any;
}

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let service: PaymentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        {
          provide: PaymentsService,
          useValue: {
            create: jest.fn(),
            createBatch: jest.fn(),
            findAll: jest.fn(),
            getStats: jest.fn(),
            findOne: jest.fn(),
            findByReference: jest.fn(),
            refund: jest.fn(),
          },
        },
        IdempotencyInterceptor,
        {
          provide: CacheService,
          useValue: { get: jest.fn(), set: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PaymentsController>(PaymentsController);
    service = module.get<PaymentsService>(PaymentsService);
  });

  describe('create', () => {
    it('forwards req.user.merchantId and the DTO to service.create', async () => {
      const dto: CreatePaymentDto = { amountUsd: 25, customerEmail: 'buyer@example.com' };
      const created = mockPayment();
      jest.spyOn(service, 'create').mockResolvedValue(created);

      const result = await controller.create(REQ as any, dto);

      expect(service.create).toHaveBeenCalledWith('m1', dto);
      expect(result).toBe(created);
    });

    it('scopes the create to the calling merchant, not a DTO-supplied merchantId', async () => {
      const dto = { amountUsd: 10, metadata: { orderId: 'o-1' } } as unknown as CreatePaymentDto;
      jest.spyOn(service, 'create').mockResolvedValue(mockPayment());

      await controller.create({ user: { merchantId: 'merchant-a' } } as any, dto);

      expect(service.create).toHaveBeenCalledWith('merchant-a', dto);
    });
  });

  describe('createBatch', () => {
    it('forwards req.user.merchantId and the whole batch DTO to service.createBatch', async () => {
      const dto: BatchCreatePaymentDto = {
        payments: [
          { amountUsd: 10, memo: 'first' },
          { amountUsd: 20, memo: 'second' },
        ],
      };
      const result = { paymentIds: ['p1', 'p2'], count: 2 };
      jest.spyOn(service, 'createBatch').mockResolvedValue(result);

      await expect(controller.createBatch(REQ as any, dto)).resolves.toBe(result);
      expect(service.createBatch).toHaveBeenCalledWith('m1', dto);
    });
  });

  describe('findAll', () => {
    it('forwards merchantId plus page/limit to service.findAll', async () => {
      const pagination: PaginationDto = Object.assign(new PaginationDto(), { page: 3, limit: 50 });
      const page = { items: [], total: 0, page: 3, limit: 50, totalPages: 0 };
      jest.spyOn(service, 'findAll').mockResolvedValue(page as any);

      const result = await controller.findAll(REQ as any, pagination);

      expect(service.findAll).toHaveBeenCalledWith('m1', 3, 50);
      expect(result).toBe(page);
    });

    it('uses the PaginationDto defaults when no query params are supplied', async () => {
      const pagination: PaginationDto = Object.assign(new PaginationDto());
      jest.spyOn(service, 'findAll').mockResolvedValue({} as any);

      await controller.findAll(REQ as any, pagination);

      expect(service.findAll).toHaveBeenCalledWith('m1', 1, 20);
    });
  });

  describe('getStats', () => {
    it('forwards req.user.merchantId to service.getStats', async () => {
      const stats = [{ status: PaymentStatus.PENDING, count: '2', totalUsd: '150.00' }];
      jest.spyOn(service, 'getStats').mockResolvedValue(stats as any);

      const result = await controller.getStats(REQ as any);

      expect(service.getStats).toHaveBeenCalledWith('m1');
      expect(result).toBe(stats);
    });
  });

  describe('findOne', () => {
    it('forwards the id and the calling merchantId to service.findOne', async () => {
      const payment = mockPayment();
      jest.spyOn(service, 'findOne').mockResolvedValue(payment);

      const result = await controller.findOne(REQ as any, 'p1');

      expect(service.findOne).toHaveBeenCalledWith('p1', 'm1');
      expect(result).toBe(payment);
    });

    it('propagates a NotFoundException from the service', async () => {
      jest.spyOn(service, 'findOne').mockRejectedValue(new Error('Payment not found'));

      await expect(controller.findOne(REQ as any, 'missing')).rejects.toThrow('Payment not found');
    });
  });

  describe('refund', () => {
    it('should call service.refund', async () => {
      const dto: RefundPaymentDto = { reason: 'Test refund', amountUsd: 50 } as RefundPaymentDto;
      const paymentId = 'p1';

      jest.spyOn(service, 'refund').mockResolvedValue({ id: paymentId, status: PaymentStatus.REFUNDED } as any);

      const result = await controller.refund(REQ as any, paymentId, dto);

      expect(service.refund).toHaveBeenCalledWith(paymentId, 'm1', dto);
      expect(result.status).toBe(PaymentStatus.REFUNDED);
    });
  });
});

describe('PublicPaymentController', () => {
  let controller: PublicPaymentController;
  let service: PaymentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicPaymentController],
      providers: [
        {
          provide: PaymentsService,
          useValue: { findByReference: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<PublicPaymentController>(PublicPaymentController);
    service = module.get<PaymentsService>(PaymentsService);
  });

  describe('getByReference', () => {
    it('looks the payment up by reference and returns a PublicPaymentViewDto', async () => {
      jest.spyOn(service, 'findByReference').mockResolvedValue(mockPayment());

      const result = await controller.getByReference('PAY-abc123');

      expect(service.findByReference).toHaveBeenCalledWith('PAY-abc123');
      expect(result).toBeInstanceOf(PublicPaymentViewDto);
      expect(result).toMatchObject({
        reference: 'PAY-abc123',
        amountUsd: '100.000000',
        network: PaymentNetwork.STELLAR,
        status: PaymentStatus.PENDING,
      });
    });

    it('omits merchant and PII fields from the public view', async () => {
      jest.spyOn(service, 'findByReference').mockResolvedValue(
        mockPayment({
          customerEmail: 'buyer@example.com',
          customerWalletAddress: 'GPRIVATE',
          metadata: { internal: true },
          refundTxHash: 'hash',
        }),
      );

      const result = await controller.getByReference('PAY-abc123');

      expect(result).not.toHaveProperty('customerEmail');
      expect(result).not.toHaveProperty('customerWalletAddress');
      expect(result).not.toHaveProperty('metadata');
      expect(result).not.toHaveProperty('merchantId');
      expect(result).not.toHaveProperty('refundTxHash');
    });

    it('propagates a NotFoundException for an unknown reference', async () => {
      jest.spyOn(service, 'findByReference').mockRejectedValue(new Error('Payment not found'));

      await expect(controller.getByReference('PAY-unknown')).rejects.toThrow('Payment not found');
    });
  });
});


