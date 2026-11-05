import { Module } from '@nestjs/common';
import { MembersController } from './members.controller.js';
import { WorkspacesController } from './workspaces.controller.js';

/** Workspace และสมาชิก · งาน: A14 */
@Module({
  controllers: [WorkspacesController, MembersController],
  providers: [],
})
export class WorkspacesModule {}
