import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';

/** Profile, การตั้งค่าส่วนตัว, วันลา · งาน: A20 */
@Module({
  controllers: [MeController],
  providers: [],
})
export class MeModule {}
