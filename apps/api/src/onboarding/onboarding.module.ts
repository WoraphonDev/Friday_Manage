import { Body, Controller, Get, HttpCode, Module, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { OnboardingService, TaskOpenedBody } from './onboarding.service.js';

/** Onboarding checklist ของลูกค้า (A43 · V1–V4) · Owner / Admin เห็นขั้นของ Workspace · Member เห็นขั้นส่วนตัว · Guest ไม่เห็น */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** ขั้น สถานะ ตัวเลขประกอบ ขั้นถัดไป และลิงก์ปุ่ม · ขั้นที่เพิ่งเสร็จถูกบันทึกตอนเรียก */
  @Get('onboarding')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.onboarding.get(auth, tenant);
  }

  /** ซ่อนการ์ดบน Home (ต่อคน) · ปุ่มท้าย Sidebar ยังอยู่ */
  @Post('onboarding\\:hide')
  @HttpCode(200)
  hide(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.onboarding.dismiss(auth, tenant, 'hide');
  }

  /** แสดงบน Home อีกครั้ง (ยกเลิกทั้งซ่อนและไม่ต้องแสดงอีก) */
  @Post('onboarding\\:show')
  @HttpCode(200)
  show(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.onboarding.dismiss(auth, tenant, 'show');
  }

  /** ไม่ต้องแสดงอีก: ซ่อนทั้งการ์ดและปุ่มท้าย Sidebar · เปิดกลับได้จากเมนูบัญชี */
  @Post('onboarding\\:never')
  @HttpCode(200)
  never(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.onboarding.dismiss(auth, tenant, 'never');
  }

  /** เห็นการ์ด "ครบแล้ว" (V4) แล้ว · แสดงครั้งเดียว */
  @Post('onboarding\\:complete-seen')
  @HttpCode(200)
  completeSeen(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.onboarding.dismiss(auth, tenant, 'complete_seen');
  }

  /** กดปุ่ม "เปิดงาน" ในรายการของสมาชิก (V3) · ต้องเป็นงานที่ได้รับมอบหมาย */
  @Post('onboarding\\:task-opened')
  @HttpCode(200)
  taskOpened(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.onboarding.taskOpened(auth, tenant, parse(TaskOpenedBody, body));
  }
}

@Module({ controllers: [OnboardingController], providers: [OnboardingService], exports: [OnboardingService] })
export class OnboardingModule {}
