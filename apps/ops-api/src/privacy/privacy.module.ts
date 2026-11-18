import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { HoldBody, HoldsService, PurgeNowBody, ReleaseBody, RetentionBody, RetentionEstimateQuery } from './holds.service.js';
import { AdvanceBody, BreachBody, BreachMarkBody, BreachPatchBody, CreateRequestBody, EraseBody, PrivacyService, RejectBody, RequestsQuery, VerifyBody } from './privacy.service.js';

/**
 * คำขอ PDPA และเหตุละเมิดข้อมูล (O05 · หน้า Privacy · A3–A6)
 * คำขอ: Support รับเรื่อง · Owner (ผู้รับผิดชอบ DPO) ทำได้ทุกขั้น · ผู้ตรวจอ่านได้
 * เหตุละเมิด: Owner และวิศวกร (คนที่มักรู้เหตุก่อน) · ลบตามคำขอต้องแตะ key ซ้ำและมีคนที่สองอนุมัติ
 */
@Controller('ops/privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly holds: HoldsService,
  ) {}

  @Roles('owner', 'support', 'auditor')
  @Get('requests')
  list(@Query() q: unknown) {
    return this.privacy.list(parse(RequestsQuery, q));
  }
  @Roles('owner', 'support', 'auditor')
  @Get('requests/:id')
  get(@Param('id') id: string) {
    return this.privacy.get(id);
  }
  @Roles('owner', 'support')
  @Post('requests')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.privacy.create(req.staff!, parse(CreateRequestBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/verify', 'requests/:id\\:verify'])
  @HttpCode(200)
  verify(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.verify(req.staff!, id, parse(VerifyBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/advance', 'requests/:id\\:advance'])
  @HttpCode(200)
  advance(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.advance(req.staff!, id, parse(AdvanceBody, body));
  }
  @Roles('owner', 'support')
  @Post(['requests/:id/reject', 'requests/:id\\:reject'])
  @HttpCode(200)
  reject(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.reject(req.staff!, id, parse(RejectBody, body));
  }
  /** ต้องอนุมัติทุกครั้ง → 202 */
  @Roles('owner', 'support')
  @Reauth()
  @Post(['requests/:id/erase', 'requests/:id\\:erase'])
  @HttpCode(202)
  erase(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.requestErase(req.staff!, id, parse(EraseBody, body));
  }
  @Roles('owner', 'support', 'auditor')
  @Get('pending-deletes')
  pendingDeletes() {
    return this.holds.pendingDeletes();
  }
  /** ลบถาวรทันที (H13) · สิ่งที่จะลบ / Ticket ให้เลือก / เงื่อนไข */
  @Roles('owner')
  @Get('pending-deletes/:id')
  purgePreview(@Param('id') id: string) {
    return this.holds.purgePreview(id);
  }
  /** ต้องมีคนที่สองอนุมัติเสมอ → 202 */
  @Roles('owner')
  @Reauth()
  @Post(['pending-deletes/:id/purge-now', 'pending-deletes/:id\\:purge-now'])
  @HttpCode(202)
  purgeNow(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.holds.requestPurgeNow(req.staff!, id, parse(PurgeNowBody, body));
  }

  /** Legal hold (H11) · อ่าน: Owner / Support / วิศวกร / ผู้ตรวจ · ตั้ง: Owner + แตะกุญแจ · ยกเลิก: ขออนุมัติ */
  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('legal-holds')
  legalHolds() {
    return this.holds.holds();
  }
  @Roles('owner')
  @Reauth()
  @Post('legal-holds')
  createHold(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.holds.createHold(req.staff!, parse(HoldBody, body));
  }
  @Roles('owner')
  @Post(['legal-holds/:id/release', 'legal-holds/:id\\:release'])
  @HttpCode(202)
  releaseHold(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.holds.requestRelease(req.staff!, id, parse(ReleaseBody, body));
  }

  /** นโยบายการเก็บข้อมูล (H12) · แก้ได้เฉพาะ Owner · สั้นลง → 202 รออนุมัติ */
  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('retention')
  retention() {
    return this.holds.retention();
  }
  @Roles('owner')
  @Get('retention/estimate')
  estimate(@Query() q: unknown) {
    return this.holds.estimate(parse(RetentionEstimateQuery, q));
  }
  @Roles('owner')
  @Reauth()
  @Put('retention')
  async setRetention(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.holds.setRetention(req.staff!, parse(RetentionBody, body));
    if ('pendingApproval' in r) res.status(202);
    return r;
  }

  @Roles('owner', 'engineer', 'auditor')
  @Get('breaches')
  breaches() {
    return this.privacy.breaches();
  }
  @Roles('owner', 'engineer', 'auditor')
  @Get('breaches/:id')
  breach(@Param('id') id: string) {
    return this.privacy.getBreach(id);
  }
  @Roles('owner', 'engineer')
  @Post('breaches')
  openBreach(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.privacy.openBreach(req.staff!, parse(BreachBody, body));
  }
  @Roles('owner', 'engineer')
  @Patch('breaches/:id')
  updateBreach(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.updateBreach(req.staff!, id, parse(BreachPatchBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/pdpc-notified', 'breaches/:id\\:pdpc-notified'])
  @HttpCode(200)
  pdpc(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.markPdpc(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/subjects-notified', 'breaches/:id\\:subjects-notified'])
  @HttpCode(200)
  subjects(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.markSubjects(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner')
  @Post(['breaches/:id/close', 'breaches/:id\\:close'])
  @HttpCode(200)
  close(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.closeBreach(req.staff!, id, parse(BreachMarkBody, body));
  }
  @Roles('owner', 'engineer')
  @Get('breaches/:id/pdpc-draft')
  draft(@Param('id') id: string) {
    return this.privacy.pdpcDraft(id);
  }
}

@Module({ controllers: [PrivacyController], providers: [PrivacyService, HoldsService], exports: [PrivacyService] })
export class PrivacyModule {}
