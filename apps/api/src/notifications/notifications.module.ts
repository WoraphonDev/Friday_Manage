import { Module } from '@nestjs/common';
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
export class NotificationsModule {}
