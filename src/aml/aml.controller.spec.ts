import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { validate } from 'class-validator';
import { AmlController, ReviewFlagDto } from './aml.controller';
import { AmlService } from './aml.service';
import { AmlFlagStatus } from './entities/aml-flag.entity';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AUDITABLE_KEY } from '../audit/decorators/auditable.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { IpAllowlistGuard } from '../security/ip-allowlist.guard';
import { MerchantRole } from '../merchants/entities/merchant.entity';

describe('AmlController', () => {
  let controller: AmlController;
  let service: {
    findAll: jest.Mock;
    findPending: jest.Mock;
    findByMerchant: jest.Mock;
    review: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findPending: jest.fn(),
      findByMerchant: jest.fn(),
      review: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AmlController],
      providers: [{ provide: AmlService, useValue: service }],
    }).compile();

    controller = module.get(AmlController);
  });

  it('delegates findAll with numeric pagination', async () => {
    service.findAll.mockResolvedValue({ flags: [], total: 0 });

    await controller.findAll('2' as any, '10' as any);

    expect(service.findAll).toHaveBeenCalledWith(2, 10);
  });

  it('delegates findPending with numeric pagination', async () => {
    service.findPending.mockResolvedValue({ flags: [], total: 0 });

    await controller.findPending('3' as any, '5' as any);

    expect(service.findPending).toHaveBeenCalledWith(3, 5);
  });

  it('delegates review using req.user identity, not client-supplied reviewedBy', async () => {
    const dto = {
      status: AmlFlagStatus.ESCALATED,
      note: 'Needs investigation',
    };
    const req: any = { user: { merchantId: 'admin-1', email: 'admin@example.com' } };
    service.review.mockResolvedValue({ id: 'flag-1' });

    await controller.review('flag-1', dto, req);

    expect(service.review).toHaveBeenCalledWith(
      'flag-1',
      AmlFlagStatus.ESCALATED,
    await controller.review('flag-1', dto, req);
      'Needs investigation',
    );
  });

  it('falls back to merchantId when email is absent', async () => {
    const dto = { status: AmlFlagStatus.CLEARED };
    const req: any = { user: { merchantId: 'admin-1' } };
    service.review.mockResolvedValue({ id: 'flag-1' });

    await controller.review('flag-1', dto, req);

    expect(service.review).toHaveBeenCalledWith(
      'flag-1',
      AmlFlagStatus.CLEARED,
      'admin-1',
      undefined,
    );
  });

  it('rejects review when the request has no authenticated identity', async () => {
    await expect(
      controller.review('flag-1', { status: AmlFlagStatus.CLEARED }, { user: {} } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(service.review).not.toHaveBeenCalled();
  });

  });

  it('delegates findByMerchant', async () => {
    service.findByMerchant.mockResolvedValue([]);

    await controller.findByMerchant('merchant-1');

    expect(service.findByMerchant).toHaveBeenCalledWith('merchant-1');
  });

  it('requires admin auth guards on the controller', () => {
    const guards = Reflect.getMetadata('__guards__', AmlController) ?? [];

    expect(guards).toContain(IpAllowlistGuard);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  it('requires ADMIN role on the controller', () => {
    const roles = Reflect.getMetadata('roles', AmlController) ?? [];

    expect(roles).toContain(MerchantRole.ADMIN);
  });

  it('marks review as auditable', () => {
    const meta = Reflect.getMetadata(AUDITABLE_KEY, AmlController.prototype.review);
    expect(meta).toEqual({ action: 'AML_FLAG_REVIEWED', resource: 'aml_flag' });
  });

  it('validates review status and optional note constraints', async () => {
    const validDto = Object.assign(new ReviewFlagDto(), {
      status: AmlFlagStatus.CLEARED,
      note: 'ok',
    });
    const invalidStatus = Object.assign(new ReviewFlagDto(), { status: 'invalid-status' });
    const oversizedNote = Object.assign(new ReviewFlagDto(), {
      status: AmlFlagStatus.CLEARED,
      note: 'x'.repeat(2001),
    });
    // reviewedBy must not be a trusted/validated client field anymore
    const withClientReviewedBy = Object.assign(new ReviewFlagDto(), {
      status: AmlFlagStatus.CLEARED,
      reviewedBy: 'spoofed-admin',
    });

    expect(await validate(validDto)).toHaveLength(0);
    expect(await validate(invalidStatus)).not.toHaveLength(0);
    expect(await validate(oversizedNote)).not.toHaveLength(0);
    // Extra client fields are ignored by the DTO (no decorators) / whitelist strip
    expect(await validate(withClientReviewedBy)).toHaveLength(0);
    expect((withClientReviewedBy as any).reviewedBy).toBe('spoofed-admin');
  });
});
