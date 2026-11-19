import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { CreateLeadBody, LeadSettings, LeadsQuery, LeadsService, NoteBody, UpdateLeadBody } from './leads.service.js';

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

@Module({ controllers: [LeadsController], providers: [LeadsService], exports: [LeadsService] })
export class SalesModule {}
