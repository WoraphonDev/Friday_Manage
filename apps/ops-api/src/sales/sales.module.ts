import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { CreateLeadBody, LeadSettings, LeadsQuery, LeadsService, NoteBody, UpdateLeadBody } from './leads.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { ExtendBody, LinkWorkspaceBody, QuoteBody, QuoteSettings, QuotesQuery, QuotesService } from './quotes.service.js';

/** ขายองค์กร › Lead และดีล (O54) · Owner */
@Controller('ops/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Roles('owner')
  @Get('summary')
  summary() {
    return this.leads.summary();
  }
  @Roles('owner')
  @Get()
  list(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.leads.list(req.staff!, parse(LeadsQuery, q));
  }
  @Roles('owner')
  @Get('export')
  async export(@Req() req: OpsRequest, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="friday-leads.csv"', 'Cache-Control': 'private, no-store' });
    return this.leads.csv(req.staff!, parse(LeadsQuery, q));
  }
  @Roles('owner')
  @Get('settings')
  settings() {
    return this.leads.settings();
  }
  @Roles('owner')
  @Put('settings')
  saveSettings(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.leads.saveSettings(req.staff!, parse(LeadSettings, body));
  }
  @Roles('owner')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.leads.detail(id);
  }
  @Roles('owner')
  @Post()
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.leads.create(req.staff!, parse(CreateLeadBody, body));
  }
  @Roles('owner')
  @Post(':id/claim')
  @HttpCode(200)
  claim(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.leads.claim(req.staff!, id);
  }
  @Roles('owner')
  @Post(':id/notes')
  note(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.leads.note(req.staff!, id, parse(NoteBody, body));
  }
  @Roles('owner')
  @Patch(':id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.leads.update(req.staff!, id, parse(UpdateLeadBody, body));
  }
}

/** ขายองค์กร › ใบเสนอราคาและสัญญา (O55) · Owner และการเงิน · ส่วนลดเกินวงเงินตอบ 202 พร้อมคำขออนุมัติ */
@Controller('ops/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Roles('owner', 'finance')
  @Get('summary')
  summary(@Req() req: OpsRequest) {
    return this.quotes.summary(req.staff!);
  }
  @Roles('owner', 'finance')
  @Get()
  list(@Query() q: unknown) {
    return this.quotes.list(parse(QuotesQuery, q));
  }
  @Roles('owner', 'finance')
  @Get('settings')
  settings() {
    return this.quotes.settings();
  }
  @Roles('owner')
  @Put('settings')
  saveSettings(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.quotes.saveSettings(req.staff!, parse(QuoteSettings, body));
  }
  @Roles('owner', 'finance')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.quotes.detail(id);
  }
  @Roles('owner', 'finance')
  @Post()
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.quotes.create(req.staff!, parse(QuoteBody, body));
  }
  @Roles('owner', 'finance')
  @Put(':id')
  update(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.quotes.update(req.staff!, id, parse(QuoteBody, body));
  }
  @Roles('owner', 'finance')
  @Post(':id/send')
  async send(@Req() req: OpsRequest, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.quotes.send(req.staff!, id);
    res.status('pendingApproval' in r ? 202 : 200);
    return r;
  }
  @Roles('owner', 'finance')
  @Post(':id/copy')
  copy(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.quotes.copy(req.staff!, id);
  }
  @Roles('owner', 'finance')
  @Post(':id/extend')
  @HttpCode(200)
  extend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.quotes.extend(req.staff!, id, parse(ExtendBody, body).days);
  }
  @Roles('owner', 'finance')
  @Post(':id/workspace')
  @HttpCode(200)
  link(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.quotes.linkWorkspace(req.staff!, id, parse(LinkWorkspaceBody, body).workspaceId);
  }
  @Roles('owner', 'finance')
  @Post(':id/setup')
  @HttpCode(200)
  setup(@Param('id') id: string) {
    return this.quotes.setup(id);
  }
}

@Module({ imports: [BillingModule], controllers: [LeadsController, QuotesController], providers: [LeadsService, QuotesService], exports: [LeadsService, QuotesService] })
export class SalesModule {}
