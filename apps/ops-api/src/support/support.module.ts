import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AccountsBody, CannedBody, PresenceBody, ReorderBody, RuleBody, RulePatch, SaveSettingsBody, SupportSettingsService } from './settings.service.js';
import { StartSessionBody, SupportService } from './support.service.js';
import { AssignBody, CreateTicketBody, CsatBody, EscalateBody, MessageBody, SolveBody, TicketsQuery, TicketsService } from './tickets.service.js';

/** เข้าบัญชีลูกค้าเพื่อช่วยเหลือ (Q3 · C1) */
@Controller('ops')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Roles('support')
  @Post(['workspaces/:id/support-sessions'])
  startSession(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.start(req.staff!, id, parse(StartSessionBody, body));
  }
  @Roles('support', 'owner')
  @Get('support-sessions')
  openSessions() {
    return this.support.open();
  }
  @Roles('support', 'owner')
  @Post(['support-sessions/:id/end', 'support-sessions/:id\\:end'])
  @HttpCode(200)
  endSession(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.support.end(req.staff!, id);
  }
}

/**
 * Ticket (O04 · หน้า Support · T1–T3, T5) · การเงินไม่เห็นข้อความใน Ticket (06 › 2) จึงเปิดเฉพาะ Support / Owner
 * ผลงานรายคนให้ Owner ดูด้วย
 */
@Controller('ops/tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Roles('support', 'owner')
  @Get()
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.tickets.list(req.staff!, parse(TicketsQuery, q));
  }
  @Roles('support', 'owner')
  @Get('stats')
  stats() {
    return this.tickets.stats();
  }
  @Roles('support', 'owner')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.tickets.get(id);
  }
  @Roles('support')
  @Post()
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.tickets.create(req.staff!, parse(CreateTicketBody, body));
  }
  @Roles('support')
  @Post([':id/claim', ':id\\:claim'])
  @HttpCode(200)
  claim(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.tickets.claim(req.staff!, id);
  }
  @Roles('support', 'owner')
  @Post([':id/assign', ':id\\:assign'])
  @HttpCode(200)
  assign(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.assign(req.staff!, id, parse(AssignBody, body));
  }
  @Roles('support', 'owner')
  @Post([':id/release', ':id\\:release'])
  @HttpCode(200)
  release(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.tickets.release(req.staff!, id);
  }
  @Roles('support')
  @Post(':id/messages')
  message(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.message(req.staff!, id, parse(MessageBody, body));
  }
  @Roles('support')
  @Post([':id/escalate', ':id\\:escalate'])
  @HttpCode(200)
  escalate(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.escalate(req.staff!, id, parse(EscalateBody, body));
  }
  @Roles('support')
  @Post([':id/solve', ':id\\:solve'])
  @HttpCode(200)
  solve(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.solve(req.staff!, id, parse(SolveBody, body));
  }
  @Roles('support')
  @Post([':id/csat', ':id\\:csat'])
  @HttpCode(200)
  rate(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.rate(req.staff!, id, parse(CsatBody, body));
  }
}

/**
 * ตั้งค่าการแจกงาน Support (O22 · SupportSettings · T4 · T6) · ดูได้ Owner / Support · แก้ได้เฉพาะ Owner
 * สถานะของตัวเองและการใช้ข้อความสำเร็จรูปเป็นของ Support
 */
@Controller('ops/support')
export class SupportSettingsController {
  constructor(private readonly settings: SupportSettingsService) {}

  @Roles('support', 'owner')
  @Get('settings')
  view(@Req() req: OpsRequest) {
    return this.settings.view(req.staff!);
  }
  @Roles('owner')
  @Put('settings')
  save(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.settings.save(req.staff!, parse(SaveSettingsBody, body));
  }
  @Roles('owner')
  @Post('rules/preview')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    return this.settings.preview(parse(RuleBody, body));
  }
  @Roles('owner')
  @Post('rules')
  createRule(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.settings.createRule(req.staff!, parse(RuleBody, body));
  }
  @Roles('owner')
  @Post('rules/reorder')
  @HttpCode(200)
  reorder(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.settings.reorder(req.staff!, parse(ReorderBody, body));
  }
  @Roles('owner')
  @Patch('rules/:id')
  patchRule(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.settings.patchRule(req.staff!, id, parse(RulePatch, body));
  }
  @Roles('owner')
  @Delete('rules/:id')
  deleteRule(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.settings.deleteRule(req.staff!, id);
  }
  @Roles('owner')
  @Put('agents/:staffId/accounts')
  accounts(@Req() req: OpsRequest, @Param('staffId') staffId: string, @Body() body: unknown) {
    return this.settings.setAccounts(req.staff!, staffId, parse(AccountsBody, body));
  }
  @Roles('support', 'owner')
  @Get('team')
  team() {
    return this.settings.team();
  }
  @Roles('support')
  @Put('presence')
  presence(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.settings.setPresence(req.staff!, parse(PresenceBody, body));
  }
  @Roles('support', 'owner')
  @Get('canned-replies')
  canned(@Query('archived') archived?: string) {
    return this.settings.canned(archived === 'true');
  }
  @Roles('owner')
  @Post('canned-replies')
  createCanned(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.settings.createCanned(req.staff!, parse(CannedBody, body));
  }
  @Roles('owner')
  @Patch('canned-replies/:id')
  updateCanned(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.settings.updateCanned(req.staff!, id, parse(CannedBody, body));
  }
  @Roles('owner')
  @Post('canned-replies/:id/archive')
  @HttpCode(200)
  archive(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.settings.archiveCanned(req.staff!, id, true);
  }
  @Roles('owner')
  @Post('canned-replies/:id/restore')
  @HttpCode(200)
  restore(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.settings.archiveCanned(req.staff!, id, false);
  }
  @Roles('support')
  @Post('canned-replies/:id/use')
  @HttpCode(200)
  use(@Param('id') id: string) {
    return this.settings.useCanned(id);
  }
}

@Module({ controllers: [SupportController, TicketsController, SupportSettingsController], providers: [SupportService, TicketsService, SupportSettingsService], exports: [TicketsService, SupportSettingsService] })
export class SupportModule {}
