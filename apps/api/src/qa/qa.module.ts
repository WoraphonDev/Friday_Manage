import { Module } from '@nestjs/common';
import { QaController } from './qa.controller.js';
import { QaService } from './qa.service.js';

/** ผลทดสอบ, สร้าง Bug จากผลทดสอบ และบันทึกเวลา · งาน A12 (docs/tasks/A12-*.md) */
@Module({
  controllers: [QaController],
  providers: [QaService],
})
export class QaModule {}
