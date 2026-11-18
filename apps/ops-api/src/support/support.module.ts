import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { BotHolidaysClient } from './bot-holidays.js';
import { AddHolidayBody, BotApplyBody, BotPreviewBody, HolidaysQuery, HolidaysService, ImpactBody, RemoveHolidayQuery } from './holidays.service.js';
import { PresenceBody, PresenceService, TeamQuery } from './presence.service.js';
import { AccountsBody, CannedBody, ReorderBody, RuleBody, RulePatch, SaveSettingsBody, SupportSettingsService } from './settings.service.js';
import { ExtendSessionBody, SessionsQuery, StartSessionBody, SupportService } from './support.service.js';
import { BulkPreviewBody, BulkStartBody, BulkTicketsService } from './bulk.service.js';
import { AssignBody, CreateTicketBody, CsatBody, EscalateBody, IncidentLinkBody, MessageBody, PriorityBody, SolveBody, TicketsQuery, TicketsService } from './tickets.service.js';

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
  openSessions(@Query() q: unknown) {
    return this.support.open(parse(SessionsQuery, q));
  }
  /** ขยายเวลา (O42 · H9) */
  @Roles('support', 'owner')
  @Post(['support-sessions/:id/extend', 'support-sessions/:id\\:extend'])
  @HttpCode(200)
  extendSession(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.support.extend(req.staff!, id, parse(ExtendSessionBody, body));
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
  constructor(
    private readonly tickets: TicketsService,
    private readonly bulk: BulkTicketsService,
  ) {}

  // ---- ช่วง 3: ทำทีละหลายเรื่อง (ประกาศก่อน :id ให้ path ไม่ชนกัน) · คนตอบ Ticket เท่านั้น
  @Roles('support')
  @Post('bulk/preview')
  @HttpCode(200)
  bulkPreview(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.bulk.preview(req.staff!, parse(BulkPreviewBody, body));
  }
  @Roles('support')
  @Post('bulk')
  @HttpCode(202)
  bulkStart(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.bulk.start(req.staff!, parse(BulkStartBody, body));
  }
  @Roles('support')
  @Get('bulk/:jobId')
  bulkJob(@Req() req: OpsRequest, @Param('jobId') id: string) {
    return this.bulk.job(req.staff!, id);
  }

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
  /** ไฟล์แนบที่ลูกค้าส่งมากับ Ticket (S6) · รูปและ PDF เปิดในหน้าได้ นอกนั้นดาวน์โหลด · nosniff กันเดาชนิดเป็น HTML */
  @Roles('support', 'owner')
  @Get(':id/messages/:messageId/files/:index')
  async file(@Param('id') id: string, @Param('messageId') messageId: string, @Param('index', ParseIntPipe) index: number, @Res({ passthrough: true }) res: Response) {
    const f = await this.tickets.file(id, messageId, index);
    const inline = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(f.mime);
    res.set({
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Length': String(f.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(f.stream);
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
  @Roles('support', 'owner')
  @Post([':id/priority', ':id\\:priority'])
  @HttpCode(200)
  priority(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.setPriority(req.staff!, id, parse(PriorityBody, body));
  }
  @Roles('support', 'owner')
  @Put(':id/incident')
  incident(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.linkIncident(req.staff!, id, parse(IncidentLinkBody, body));
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
  constructor(
    private readonly settings: SupportSettingsService,
    private readonly presenceSvc: PresenceService,
    private readonly holidays: HolidaysService,
  ) {}

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
  /** ทีมตอนนี้ + คิวกลาง · หน้า Support เรียกทุก 1 นาที (seen=1 เมื่อแท็บแสดงอยู่ = มีการใช้งาน) */
  @Roles('support', 'owner')
  @Get('team')
  team(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.presenceSvc.team(req.staff!, parse(TeamQuery, q).seen === '1');
  }
  @Roles('support')
  @Put('presence')
  presence(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.presenceSvc.setPresence(req.staff!, parse(PresenceBody, body));
  }

  // ── ปฏิทินวันหยุดของระบบ (รอบ 4 · S1–S2) · Owner / Support ──
  @Roles('support', 'owner')
  @Get('holidays')
  holidayList(@Query() q: unknown) {
    return this.holidays.list(parse(HolidaysQuery, q));
  }
  @Roles('support', 'owner')
  @Post('holidays/impact')
  @HttpCode(200)
  holidayImpact(@Body() body: unknown) {
    return this.holidays.impact(parse(ImpactBody, body).dates);
  }
  @Roles('support', 'owner')
  @Post('holidays/bot/preview')
  @HttpCode(200)
  botPreview(@Body() body: unknown) {
    return this.holidays.botPreview(parse(BotPreviewBody, body).year);
  }
  @Roles('support', 'owner')
  @Post('holidays/bot/apply')
  @HttpCode(200)
  botApply(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.holidays.botApply(req.staff!, parse(BotApplyBody, body));
  }
  @Roles('support', 'owner')
  @Post('holidays')
  addHoliday(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.holidays.add(req.staff!, parse(AddHolidayBody, body));
  }
  @Roles('support', 'owner')
  @Delete('holidays/:date')
  removeHoliday(@Req() req: OpsRequest, @Param('date') date: string, @Query() q: unknown) {
    return this.holidays.remove(req.staff!, date, parse(RemoveHolidayQuery, q));
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

@Module({
  controllers: [SupportController, TicketsController, SupportSettingsController],
  providers: [SupportService, TicketsService, BulkTicketsService, SupportSettingsService, PresenceService, HolidaysService, BotHolidaysClient],
  exports: [TicketsService, SupportSettingsService, PresenceService],
})
export class SupportModule {}
