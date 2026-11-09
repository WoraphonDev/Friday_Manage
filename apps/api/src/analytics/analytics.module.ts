import { Body, Controller, Global, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AnalyticsService, CancellationBody, EventsBody } from './analytics.service.js';

/** เก็บข้อมูลธุรกิจ (A34 · 05-business-metrics) */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** เหตุการณ์จากหน้าเว็บ (สูงสุด 50 รายการต่อครั้ง) · ตอบ 202 เสมอเมื่อข้อมูลถูกรูปแบบ แม้บันทึกไม่สำเร็จ */
  @Post('events')
  @HttpCode(202)
  track(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.analytics.track(auth, tenant, parse(EventsBody, body));
  }

  /** แบบสอบถามตอนกดยกเลิกแพ็กเกจ (W22) */
  @Post('cancellation-feedback')
  cancellation(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.analytics.cancellation(auth, tenant, parse(CancellationBody, body));
  }
}

/** Global: auth / workspaces / payments / privacy เรียกบันทึกข้อมูลได้โดยไม่ต้อง import */
@Global()
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
