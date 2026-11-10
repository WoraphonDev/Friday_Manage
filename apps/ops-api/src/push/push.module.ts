import { Body, Controller, Get, Global, HttpCode, Module, Post, Req } from '@nestjs/common';
import type { OpsRequest } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { PushService, SubscribeBody, UnsubscribeBody } from './push.service.js';

/** Web Push ของพนักงาน (O25) · ทุกบทบาทสมัครรับของตัวเองได้ · ข้อความที่ได้ขึ้นกับบทบาท */
@Controller('ops/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get()
  status(@Req() req: OpsRequest) {
    return this.push.status(req.staff!);
  }
  @Post('subscriptions')
  @HttpCode(200)
  subscribe(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.push.subscribe(req.staff!, parse(SubscribeBody, body));
  }
  @Post(['subscriptions/remove', 'subscriptions\\:remove'])
  @HttpCode(200)
  unsubscribe(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.push.unsubscribe(req.staff!, parse(UnsubscribeBody, body));
  }
  @Post('test')
  @HttpCode(200)
  test(@Req() req: OpsRequest) {
    return this.push.test(req.staff!);
  }
}

/** Global: ApprovalsService / SystemService / งานคิวชำระเรียก PushService ได้โดยไม่ต้อง import */
@Global()
@Module({ controllers: [PushController], providers: [PushService], exports: [PushService] })
export class PushModule {}
