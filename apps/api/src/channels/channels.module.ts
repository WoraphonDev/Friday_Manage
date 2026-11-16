import { type MiddlewareConsumer, Module, type NestModule, type OnModuleInit } from '@nestjs/common';
import { ChannelsController, ProjectNotifyController } from './channels.controller.js';
import { ChannelsService, DnsChecker } from './channels.service.js';
import { ChannelDispatcher } from './dispatcher.js';
import { EmailFeedbackController, EmailFeedbackService, SnsVerifier } from './email-feedback.js';
import { countTraffic, InternalMetricsController } from './internal-metrics.js';
import { ProjectNotifyService } from './project-notify.service.js';
import { ChannelRegistry, EmailSender, WebhookSender } from './senders.js';

/**
 * ส่งแจ้งเตือนออกนอกแอป: Email, Webhook (A25) · LINE (A24) ลงทะเบียน sender ผ่าน `ChannelRegistry.register`
 * เส้นทาง: notifications ใหม่ → ChannelDispatcher → notification_deliveries → คิว (retry, ช่วงงดส่ง, Safe mode)
 */
@Module({
  controllers: [ChannelsController, ProjectNotifyController, EmailFeedbackController, InternalMetricsController],
  providers: [ChannelRegistry, EmailSender, WebhookSender, ChannelDispatcher, EmailFeedbackService, SnsVerifier, ChannelsService, ProjectNotifyService, DnsChecker],
  exports: [ChannelRegistry, ChannelDispatcher],
})
export class ChannelsModule implements OnModuleInit, NestModule {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly email: EmailSender,
    private readonly webhook: WebhookSender,
  ) {}

  onModuleInit() {
    this.registry.register(this.email);
    this.registry.register(this.webhook);
  }

  /**
   * ตัวนับคำขอ / 5xx ของหน้าสถานะระบบ (Friday Ops S10) · ฝากไว้ที่ module นี้เพราะ app.module.ts เป็นไฟล์กลาง
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(countTraffic).forRoutes('{*path}');
  }
}
