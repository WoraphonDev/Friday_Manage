import { Module } from '@nestjs/common';
import { InsightsService } from './insights.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Lead Dashboard และ Reports · งาน A09 (docs/tasks/A09-*.md) */
@Module({
  controllers: [ReportsController],
  providers: [InsightsService, ReportsService],
  exports: [InsightsService, ReportsService],
})
export class ReportsModule {}
