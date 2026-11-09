import { Body, Controller, Delete, Get, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AcceptancesQuery, CreateVersionBody, LegalService } from './legal.service.js';

/** เอกสารกฎหมาย (O05 · A7) · สร้าง / ยกเลิกเวอร์ชันได้เฉพาะ Owner (แตะ key ซ้ำ) · ผู้ตรวจดูหลักฐานการยอมรับได้ */
@Controller('ops/legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Roles('owner', 'auditor')
  @Get('documents')
  documents() {
    return this.legal.documents();
  }
  @Roles('owner', 'auditor')
  @Get('documents/:id')
  get(@Param('id') id: string) {
    return this.legal.get(id);
  }
  @Roles()
  @Reauth()
  @Post('documents')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.legal.create(req.staff!, parse(CreateVersionBody, body));
  }
  @Roles()
  @Reauth()
  @Delete('documents/:id')
  cancel(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.legal.cancel(req.staff!, id);
  }
  @Roles('owner', 'auditor')
  @Get('acceptances')
  acceptances(@Query() q: unknown) {
    return this.legal.acceptances(parse(AcceptancesQuery, q));
  }
  @Roles('owner', 'auditor')
  @Get('acceptances/export')
  async export(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="legal-acceptances.csv"', 'Cache-Control': 'private, no-store' });
    return this.legal.acceptancesCsv(parse(AcceptancesQuery, q));
  }
}

@Module({ controllers: [LegalController], providers: [LegalService] })
export class LegalModule {}
