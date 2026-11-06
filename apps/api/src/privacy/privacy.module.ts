import { Module } from '@nestjs/common';
import { DataRequestsService } from './data-requests.service.js';
import { ExportsService } from './exports.service.js';
import { WorkspaceLifecycleService } from './lifecycle.service.js';
import { PrivacyController, WorkspaceRecoveryController } from './privacy.controller.js';
import { SupportAccessService } from './support-access.service.js';

/** PDPA, Export ข้อมูล Workspace, สิทธิ์ทีม Friday, ลบ Workspace · งาน A31 (docs/tasks/A31-privacy.md) */
@Module({
  controllers: [PrivacyController, WorkspaceRecoveryController],
  providers: [ExportsService, DataRequestsService, SupportAccessService, WorkspaceLifecycleService],
})
export class PrivacyModule {}
