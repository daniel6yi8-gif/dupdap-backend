import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { MerchantRole } from '../../merchants/entities/merchant.entity';

interface JwtUser {
  merchantId: string;
  email: string;
  role: MerchantRole;
}

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user: JwtUser }>().user;
    if (user?.role !== MerchantRole.SUPERADMIN) {
      throw new ForbiddenException('SuperAdmin access required');
    }
    return true;
  }
}
