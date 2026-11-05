import { Module } from '@nestjs/common';
import { InvitationsController, WorkspaceInvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

/** คำเชิญ · งาน: A14 */
@Module({
  controllers: [WorkspaceInvitationsController, InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
