import { Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service.js';

/** Realtime (WebSocket) · งาน A17 (docs/tasks/A17-*.md) · โมดูลอื่นฉีด RealtimeService แล้วเรียก publish() ได้ */
@Module({
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
