import { Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { MembersService } from './members.service.js';
import { MembersController } from './members.controller.js';
import { JoinController, WorkspaceAdminController, WorkspaceJoinRequestController } from './workspace-admin.controller.js';
import { WorkspacesController } from './workspaces.controller.js';

/** Workspace, สมาชิก, ลิงก์เชิญ และคำขอเข้าร่วม · งาน A14 (docs/tasks/A14-*.md) */
@Module({
  controllers: [WorkspacesController, MembersController, WorkspaceAdminController, WorkspaceJoinRequestController, JoinController],
  providers: [MembersService, AccessService],
})
export class WorkspacesModule {}
