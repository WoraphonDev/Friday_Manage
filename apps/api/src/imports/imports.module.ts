import { Module } from '@nestjs/common';
import { InvitationsModule } from '../invitations/invitations.module.js';
import { ImportsController, ImportTemplateController, PlanExportController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

/** Import / Export Excel · งาน: A15 */
@Module({
  imports: [InvitationsModule],
  controllers: [ImportsController, ImportTemplateController, PlanExportController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
