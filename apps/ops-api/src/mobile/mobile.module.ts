import { Controller, Get, Module, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { MobileService } from './mobile.service.js';

/** Friday Ops บนมือถือ (O25 · M6) · อ่านอย่างเดียว · การตัดสินใช้ endpoint เดิมที่ตรวจสิทธิ์และลง Audit อยู่แล้ว */
@Controller('ops/m')
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Roles('owner')
  @Get('approvals')
  approvals(@Req() req: OpsRequest) {
    return this.mobile.approvals(req.staff!);
  }
  @Roles('finance', 'owner')
  @Get('payments')
  payments() {
    return this.mobile.payments();
  }
}

@Module({ imports: [PaymentsModule], controllers: [MobileController], providers: [MobileService] })
export class MobileModule {}
