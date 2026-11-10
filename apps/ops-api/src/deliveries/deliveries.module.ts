import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AttachBody, DeliveriesService, ListQuery, RemoveBody, ResendBody, SuppressionQuery } from './deliveries.service.js';

/** ประวัติการส่งแจ้งเตือน และรายชื่อไม่ส่งอีเมล (O23) · Owner, Support, วิศวกร · แนบใน Ticket: Owner, Support */
@Controller('ops')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Roles('owner', 'support', 'engineer')
  @Get('deliveries')
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.deliveries.list(req.staff!, parse(ListQuery, q));
  }

  @Roles('owner', 'support', 'engineer')
  @Get('deliveries/:id')
  detail(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.deliveries.detail(req.staff!, id);
  }

  @Roles('owner', 'support', 'engineer')
  @Post('deliveries/:id/resend')
  @HttpCode(200)
  resend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.deliveries.resend(req.staff!, id, parse(ResendBody, body ?? {}));
  }

  @Roles('owner', 'support')
  @Post('deliveries/:id/attach')
  @HttpCode(200)
  attach(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.deliveries.attach(req.staff!, id, parse(AttachBody, body));
  }

  @Roles('owner', 'support', 'engineer')
  @Get('email-suppressions')
  suppressions(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.deliveries.suppressions(req.staff!, parse(SuppressionQuery, q));
  }

  @Roles('owner', 'support')
  @Post('email-suppressions/:id/remove')
  @HttpCode(200)
  remove(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.deliveries.removeSuppression(req.staff!, id, parse(RemoveBody, body));
  }
}

@Module({ controllers: [DeliveriesController], providers: [DeliveriesService] })
export class DeliveriesModule {}
