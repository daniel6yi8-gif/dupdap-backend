import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { SettlementsService } from './settlements.service';
import { AdminSettlementsQueryDto } from './dto/admin-settlements-query.dto';
import { Request } from 'express';
import { Auditable } from '../audit/decorators/auditable.decorator';

@Controller('admin/settlements')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminSettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  @Get()
  async findAll(@Query() query: AdminSettlementsQueryDto) {
    return this.settlementsService.findAllAdmin(query);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: 'SETTLEMENT_RETRIED', resource: 'settlement' })
  async retrySettlement(@Param('id') id: string) {
    const result = await this.settlementsService.retrySettlement(id);
    if (!result.success) {
      throw new BadRequestException(result.message);
    }
    return { message: 'Settlement retry initiated successfully' };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: 'SETTLEMENT_APPROVED', resource: 'settlement' })
  async approveSettlement(
    @Param('id') id: string,
    @Req() req: Request & { user: { merchantId: string } },
  ) {
    const result = await this.settlementsService.approveSettlement(id, req.user?.merchantId);
    if (!result.success) {
      throw new BadRequestException(result.message);
    }
    return { message: 'Settlement approved successfully' };
  }
}