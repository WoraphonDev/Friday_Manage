import { Module } from '@nestjs/common';
import { LeavesService } from './leaves.service.js';
import { MeController, MyMembershipController } from './me.controller.js';
import { ProfileService } from './profile.service.js';

/** Profile, การตั้งค่าส่วนตัว, วันลา · งาน A20 (docs/tasks/A20-*.md) */
@Module({
  controllers: [MeController, MyMembershipController],
  providers: [ProfileService, LeavesService],
})
export class MeModule {}
