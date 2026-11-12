import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AnnouncementsModule } from './announcements/announcements.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { BillingModule } from './billing/billing.module.js';
import { ChangelogModule } from './changelog/changelog.module.js';
import { DbModule } from './db.js';
import { DeliveriesModule } from './deliveries/deliveries.module.js';
import { EntitlementsModule } from './entitlements/entitlements.module.js';
import { ErrorFilter } from './errors.js';
import { FlagsModule } from './flags/flags.module.js';
import { LegalModule } from './legal/legal.module.js';
import { MailModule } from './mail.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { MobileModule } from './mobile/mobile.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrivacyModule } from './privacy/privacy.module.js';
import { PromotionsModule } from './promotions/promotions.module.js';
import { PushModule } from './push/push.module.js';
import { StaffModule } from './staff/staff.module.js';
import { SupportModule } from './support/support.module.js';
import { SystemModule } from './system/system.module.js';
import { UsersModule } from './users/users.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

/**
 * หลังบ้านทีม Friday (ops.fridaymanage.com) · แอปแยกจาก apps/api: โดเมน, session และบัญชีฐานข้อมูลของตัวเอง
 * 1 เรื่อง = 1 module (lane ของงาน O02–O06) · ไฟล์นี้แก้เฉพาะ O01
 */
@Module({
  imports: [
    DbModule, MailModule, PushModule, ApprovalsModule, StaffModule, MetricsModule,
    WorkspacesModule, UsersModule, SupportModule, SystemModule,
    PaymentsModule, BillingModule, PrivacyModule, LegalModule, FlagsModule, EntitlementsModule, DeliveriesModule, MobileModule, AnnouncementsModule, PromotionsModule, ChangelogModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}
