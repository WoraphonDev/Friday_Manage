import { Module } from '@nestjs/common';
import { CalendarFeedsController, IcalController, ProjectCalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';

/** ปฏิทินโปรเจกต์ และ iCal · งาน A21 (docs/tasks/A21-*.md) */
@Module({
  controllers: [ProjectCalendarController, CalendarFeedsController, IcalController],
  providers: [CalendarService],
})
export class CalendarModule {}
