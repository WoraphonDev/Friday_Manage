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
import { IssuesController } from './issues/issues.controller.js';
import { IssuesService } from './issues/issues.service.js';
import { MeController } from './me/me.controller.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';

@Module({
  imports: [DbModule],
  controllers: [AuthController, MeController, WorkspacesController, ProjectsController, IssuesController],
  providers: [
    SessionService,
    TenantDb,
    TenantGuard,
    ProjectsService,
    IssuesService,
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
