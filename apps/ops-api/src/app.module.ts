import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { DbModule } from './db.js';
import { ErrorFilter } from './errors.js';
import { FlagsService } from './flags/flags.service.js';
import { Mailer } from './mail.js';
import { MetricsService } from './metrics.service.js';
import { OpsController } from './ops.controller.js';
import { OpsPaymentsService } from './payments/ops-payments.service.js';
import { SupportService } from './support/support.service.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';

/** หลังบ้านทีม Friday (ops.friday.app) · แอปแยกจาก apps/api: โดเมน, session และบัญชีฐานข้อมูลของตัวเอง */
@Module({
  imports: [DbModule],
  controllers: [AuthController, OpsController],
  providers: [
    AuthService,
    Mailer,
    MetricsService,
    WorkspacesService,
    SupportService,
    OpsPaymentsService,
    FlagsService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {}
