import { randomBytes } from 'node:crypto';
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { NextFunction, Response } from 'express';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { SessionService } from './auth/sessions.js';
import { ErrorFilter } from './common/errors.js';
import type { AppRequest } from './common/request.js';
import { TenantDb, TenantGuard } from './common/tenant.js';
import { DbModule } from './db/db.module.js';
import { DueRequestsController } from './due-requests/due-requests.controller.js';
import { DueRequestsService } from './due-requests/due-requests.service.js';
import { ImportsController } from './imports/imports.controller.js';
import { ImportsService } from './imports/imports.service.js';
import { InvitationsController, WorkspaceInvitationsController } from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { IssuesController } from './issues/issues.controller.js';
import { IssuesService } from './issues/issues.service.js';
import { MeController } from './me/me.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { Notifier } from './notifications/notifier.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { MembersController } from './workspaces/members.controller.js';
import { ViewsController } from './views/views.controller.js';
import { ViewsService } from './views/views.service.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';

@Module({
  imports: [DbModule],
  controllers: [
    AuthController,
    MeController,
    WorkspacesController,
    MembersController,
    WorkspaceInvitationsController,
    InvitationsController,
    ProjectsController,
    IssuesController,
    ImportsController,
    DueRequestsController,
    NotificationsController,
    ViewsController,
  ],
  providers: [
    SessionService,
    TenantDb,
    TenantGuard,
    ProjectsService,
    IssuesService,
    InvitationsService,
    ImportsService,
    Notifier,
    DueRequestsService,
    NotificationsService,
    ViewsService,
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
