import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller.js';
import { OverviewService } from './overview.service.js';

/** Overview และ Workload · งาน A08 · การคำนวณ Workload อยู่ใน workload.ts (A09, A10 import ได้) */
@Module({
  controllers: [OverviewController],
  providers: [OverviewService],
  exports: [OverviewService],
})
export class OverviewModule {}
