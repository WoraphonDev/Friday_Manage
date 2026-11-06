import { Module, type OnModuleInit } from '@nestjs/common';
import { ChannelRegistry } from '../channels/senders.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { DueRequestsModule } from '../due-requests/due-requests.module.js';
import { LineHookController, LineChannelController, MeLineController } from './line.controller.js';
import { LineApi } from './line-api.js';
import { LineGroupSender, LinePersonalSender } from './line.sender.js';
import { LineService } from './line.service.js';

/** LINE OA: ผูกบัญชี, กลุ่ม, ส่งแจ้งเตือน และปุ่มอนุมัติคำขอเลื่อน Due · งาน A24 (docs/tasks/A24-*.md) */
@Module({
  imports: [ChannelsModule, DueRequestsModule],
  controllers: [LineChannelController, MeLineController, LineHookController],
  providers: [LineApi, LineService, LinePersonalSender, LineGroupSender],
})
export class LineModule implements OnModuleInit {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly personal: LinePersonalSender,
    private readonly group: LineGroupSender,
  ) {}

  onModuleInit() {
    this.registry.register(this.personal);
    this.registry.register(this.group);
  }
}
