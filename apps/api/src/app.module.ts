import { randomBytes } from 'node:crypto';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { NextFunction, Response } from 'express';
import { AuthGuard } from './auth/auth.guard.js';
import { ErrorFilter } from './common/errors.js';
import type { AppRequest } from './common/request.js';
import { CoreModule } from './core/core.module.js';
import { DbModule } from './db/db.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AutomationModule } from './automation/automation.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { DueRequestsModule } from './due-requests/due-requests.module.js';
import { FilesModule } from './files/files.module.js';
import { GanttModule } from './gantt/gantt.module.js';
import { GitModule } from './git/git.module.js';
import { HomeModule } from './home/home.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { IssuePartsModule } from './issue-parts/issue-parts.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { LineModule } from './line/line.module.js';
import { MeModule } from './me/me.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OverviewModule } from './overview/overview.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';
import { PrivacyModule } from './privacy/privacy.module.js';
import { ProjectStructureModule } from './project-structure/project-structure.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { PublicModule } from './public/public.module.js';
import { QaModule } from './qa/qa.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SearchModule } from './search/search.module.js';
import { SprintsModule } from './sprints/sprints.module.js';
import { ViewsModule } from './views/views.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

/**
 * แต่ละโฟลเดอร์ใน src/ เป็น 1 module และเป็นเจ้าของ (lane) ของงาน 1 งานใน docs/tasks/
 * ลงทะเบียนครบทุก module ไว้ล่วงหน้าแล้ว งานแต่ละงานแก้แค่ module ของตัวเอง ไม่ต้องแก้ไฟล์นี้
 */
@Module({
  imports: [
    DbModule,
    CoreModule,
    AdminModule,
    AuthModule,
    AutomationModule,
    BillingModule,
    CalendarModule,
    ChannelsModule,
    CommentsModule,
    DueRequestsModule,
    FilesModule,
    GanttModule,
    GitModule,
    HomeModule,
    ImportsModule,
    InvitationsModule,
    IssuePartsModule,
    IssuesModule,
    LineModule,
    MeModule,
    NotificationsModule,
    OverviewModule,
    PaymentsModule,
    PrivacyModule,
    OpenApiModule,
    ProjectStructureModule,
    ProjectsModule,
    PublicModule,
    QaModule,
    QueueModule,
    RealtimeModule,
    ReportsModule,
    SearchModule,
    SprintsModule,
    ViewsModule,
    WorkspacesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // requestId แสดงในหน้า Error ให้ผู้ใช้คัดลอกส่งทีมช่วยเหลือ (M1)
    consumer
      .apply((req: AppRequest, res: Response, next: NextFunction) => {
        req.id = `req_${randomBytes(4).toString('hex')}`;
        res.setHeader('X-Request-Id', req.id);
        next();
      })
      .forRoutes('{*path}');
  }
}
