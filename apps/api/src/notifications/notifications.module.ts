import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../core/events.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { NotificationFanout } from './fanout.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { Reminders } from './reminders.js';

/**
 * Inbox และการกระจายแจ้งเตือน (Notifier อยู่ใน CoreModule) · งาน: A23
 * NotificationFanout ฟัง EventBus และลงทะเบียนงานตามเวลากับ Jobs (A16) ใน onModuleInit
 */
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationFanout, Reminders],
  exports: [NotificationsService, Reminders],
})
export class NotificationsModule implements NestModule {
  /** S7: เปิดบริบทคำขอให้ EventBus / Notifier อ่าน requestId ได้ (app.module เป็นไฟล์กลาง จึงลงทะเบียนที่นี่) */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((req: Request & { id?: string }, _res: Response, next: NextFunction) => requestContext.run({ req }, next)).forRoutes('{*path}');
  }
}
