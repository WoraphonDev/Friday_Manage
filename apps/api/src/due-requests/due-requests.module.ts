import { Module } from '@nestjs/common';
import { DueRequestsController } from './due-requests.controller.js';
import { DueRequestsService } from './due-requests.service.js';

/** คำขอเลื่อน Due · งาน: เสร็จแล้ว · A24 เรียก decide() จากปุ่ม LINE */
@Module({
  controllers: [DueRequestsController],
  providers: [DueRequestsService],
  exports: [DueRequestsService],
})
export class DueRequestsModule {}
