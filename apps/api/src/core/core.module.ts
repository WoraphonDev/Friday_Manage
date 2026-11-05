import { Global, Module } from '@nestjs/common';
import { SessionService } from '../auth/sessions.js';
import { TenantDb, TenantGuard } from '../common/tenant.js';
import { DbModule } from '../db/db.module.js';
import { IssuesService } from '../issues/issues.service.js';
import { Notifier } from '../notifications/notifier.js';
import { ProjectsService } from '../projects/projects.service.js';
import { EventBus } from './events.js';
import { Mailer } from './mail.js';
import { PlanLimits } from './plan-limits.js';

/**
 * บริการที่ทุก module ใช้ร่วมกัน · inject ได้ทุกที่โดยไม่ต้อง import module นี้
 * เจ้าของไฟล์ที่ให้บริการเหล่านี้ดู docs/tasks/README.md › Lane
 */
@Global()
@Module({
  imports: [DbModule],
  providers: [SessionService, TenantDb, TenantGuard, ProjectsService, IssuesService, Notifier, EventBus, PlanLimits, Mailer],
  exports: [SessionService, TenantDb, TenantGuard, ProjectsService, IssuesService, Notifier, EventBus, PlanLimits, Mailer],
})
export class CoreModule {}
