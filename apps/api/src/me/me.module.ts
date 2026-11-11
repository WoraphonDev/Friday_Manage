import { Module } from '@nestjs/common';
import { AvatarsController, MyAvatarController } from './avatar.controller.js';
import { LeavesService } from './leaves.service.js';
import { MeController, MyMembershipController } from './me.controller.js';
import { ProfileService } from './profile.service.js';

/** Profile, การตั้งค่าส่วนตัว, วันลา · งาน A20 (docs/tasks/A20-*.md) */
@Module({
  controllers: [MeController, MyMembershipController, MyAvatarController, AvatarsController],
  providers: [ProfileService, LeavesService],
})
export class MeModule {}
