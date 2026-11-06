import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CalendarsService } from './calendars.service.js';
import { TeamsService } from './teams.service.js';
import { TemplatesService } from './templates.service.js';

/** Admin Console ของ Workspace · งาน A18 (docs/tasks/A18-admin-console.md) */
@Module({
  controllers: [AdminController],
  providers: [AdminService, CalendarsService, TemplatesService, TeamsService],
  exports: [CalendarsService],
})
export class AdminModule {}
