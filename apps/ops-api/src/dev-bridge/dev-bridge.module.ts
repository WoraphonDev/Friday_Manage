import { Body, Controller, Delete, Get, Headers, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Public, type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { SupportModule } from '../support/support.module.js';
import { DevBridgeService, EscalateBody, LinkBody, LinksQuery, NotifyBody, ResolveBody, SearchQuery, SettingsBody } from './dev-bridge.service.js';

/**
 * O36 · ส่งบั๊กให้ทีมพัฒนา (บอร์ด 20 · T3 · T7–T11) · หน้าและรายการ: Owner / Support / วิศวกร
 * ส่งต่อ / ผูก / แจ้งลูกค้า: Support · ตั้งค่าการเชื่อมต่อ: Owner / วิศวกร (เปลี่ยน token ต้องแตะ Security key)
 */
@Controller('ops/dev-bridge')
export class DevBridgeController {
  constructor(private readonly bridge: DevBridgeService) {}

  @Roles('owner', 'support', 'engineer')
  @Get('overview')
  overview(@Req() req: OpsRequest) {
    return this.bridge.overview(req.staff!);
  }
  @Roles('owner', 'support', 'engineer')
  @Get('links')
  links(@Query() q: unknown) {
    return this.bridge.links(parse(LinksQuery, q));
  }
  @Roles('owner', 'support', 'engineer')
  @Get('settings')
  settings(@Req() req: OpsRequest) {
    return this.bridge.settings(req.staff!);
  }
  @Roles('owner', 'engineer')
  @Put('settings')
  save(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.bridge.saveSettings(req, parse(SettingsBody, body));
  }
  @Roles('owner', 'engineer')
  @Post(['settings/test', 'settings\\:test'])
  @HttpCode(200)
  test(@Req() req: OpsRequest) {
    return this.bridge.test(req.staff!);
  }
  @Roles('owner', 'support', 'engineer')
  @Get('issues')
  search(@Query() q: unknown) {
    return this.bridge.search(parse(SearchQuery, q));
  }
  @Roles('owner', 'support', 'engineer')
  @Get('tickets/:ticketId')
  forTicket(@Param('ticketId') id: string) {
    return this.bridge.forTicket(id);
  }
  @Roles('support')
  @Post(['tickets/:ticketId/escalate', 'tickets/:ticketId\\:escalate'])
  @HttpCode(200)
  escalate(@Req() req: OpsRequest, @Param('ticketId') id: string, @Body() body: unknown) {
    return this.bridge.escalate(req.staff!, id, parse(EscalateBody, body));
  }
  @Roles('support')
  @Post('tickets/:ticketId/link')
  @HttpCode(200)
  link(@Req() req: OpsRequest, @Param('ticketId') id: string, @Body() body: unknown) {
    return this.bridge.relink(req.staff!, id, parse(LinkBody, body));
  }
  @Roles('support')
  @Delete('tickets/:ticketId/link')
  unlink(@Req() req: OpsRequest, @Param('ticketId') id: string) {
    return this.bridge.unlink(req.staff!, id);
  }
  @Roles('support')
  @Get('links/:id/notify')
  preview(@Param('id') id: string) {
    return this.bridge.notifyPreview(id);
  }
  @Roles('support')
  @Post(['links/:id/notify', 'links/:id\\:notify'])
  @HttpCode(200)
  notify(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.bridge.notify(req.staff!, id, parse(NotifyBody, body));
  }
  @Roles('support')
  @Post(['links/:id/resolve', 'links/:id\\:resolve'])
  @HttpCode(200)
  resolve(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.bridge.resolve(req.staff!, id, parse(ResolveBody, body));
  }
}

/** Webhook issue.updated / issue.status_changed จากโปรเจกต์ FM · ไม่มี session จึงตรวจลายเซ็นแทน (ops-api ไม่เปิดสู่ภายนอก) */
@Controller('ops/hooks')
export class FmHookController {
  constructor(private readonly bridge: DevBridgeService) {}

  @Public()
  @Post('fm')
  @HttpCode(200)
  hook(@Headers() headers: Record<string, string | string[] | undefined>, @Body() body: unknown) {
    return this.bridge.hook(headers, body);
  }
}

@Module({ imports: [SupportModule], controllers: [DevBridgeController, FmHookController], providers: [DevBridgeService], exports: [DevBridgeService] })
export class DevBridgeModule {}
