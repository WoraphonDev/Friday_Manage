import { Module } from '@nestjs/common';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

/** Kanban และ Timeline · งาน: เสร็จแล้ว */
@Module({
  controllers: [ViewsController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
