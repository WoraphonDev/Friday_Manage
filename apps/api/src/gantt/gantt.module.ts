import { Module } from '@nestjs/common';
import { ViewsModule } from '../views/views.module.js';
import { GanttController } from './gantt.controller.js';
import { GanttService } from './gantt.service.js';

/** Gantt, Baseline, การแก้ไขแผน, Auto-schedule · งาน A07 (docs/tasks/A07-*.md) */
@Module({
  imports: [ViewsModule],
  controllers: [GanttController],
  providers: [GanttService],
})
export class GanttModule {}
