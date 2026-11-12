import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { SupportModule } from '../support/support.module.js';
import { ExtendBody, LookupQuery, RestoreBody, RestoreService, RestoreWorkspaceBody, TicketsQuery, TrashQuery } from './restore.service.js';

/**
 * กู้คืนข้อมูลลูกค้า (O31 · บอร์ด 21 · Z6–Z9)
 * Support กู้งาน / โปรเจกต์ / ไฟล์ และยืดเวลา · Owner อนุมัติ · วิศวกรและผู้ตรวจอ่านอย่างเดียว · การเงินไม่มีสิทธิ์
 */
@Controller('ops/restore')
export class RestoreController {
  constructor(private readonly restore: RestoreService) {}

  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('summary')
  summary() {
    return this.restore.summary();
  }

  /** รายการในถังขยะของ Workspace (ต้องเลือก Ticket) · ไม่แสดงชื่องาน / ชื่อไฟล์ */
  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('trash')
  trash(@Query() q: unknown) {
    return this.restore.trash(parse(TrashQuery, q));
  }

  /** Ticket ที่ยังไม่ปิดของ Workspace (ใช้เลือกก่อนค้น) */
  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('tickets')
  tickets(@Query() q: unknown) {
    return this.restore.tickets(parse(TicketsQuery, q));
  }

  /** Z9 · ค้นด้วยเลขงาน / Key */
  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('lookup')
  lookup(@Query() q: unknown) {
    return this.restore.lookup(parse(LookupQuery, q));
  }

  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('history')
  history() {
    return this.restore.history();
  }

  /** Z6 · กู้คืนให้ลูกค้า (ไม่ต้องอนุมัติคนที่สอง) */
  @Roles('owner', 'support')
  @Post()
  @HttpCode(200)
  restoreItems(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.restore.restore(req.staff!, parse(RestoreBody, body));
  }

  @Roles('owner', 'support', 'engineer', 'auditor')
  @Get('workspaces')
  pending() {
    return this.restore.pendingWorkspaces();
  }

  /** Z7 · ยืดเวลา · รวมเกิน 30 วันตอบ 202 รออนุมัติ */
  @Roles('owner', 'support')
  @Post(['workspaces/:id/extend', 'workspaces/:id\\:extend'])
  @HttpCode(200)
  async extend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.restore.extend(req.staff!, id, parse(ExtendBody, body));
    if ('pendingApproval' in r) res.status(202);
    return r;
  }

  /** Z8 · กู้ Workspace แทนลูกค้า · แตะ key (G4) + อนุมัติทุกครั้ง → 202 */
  @Roles('owner', 'support')
  @Reauth()
  @Post(['workspaces/:id/restore', 'workspaces/:id\\:restore'])
  @HttpCode(202)
  restoreWorkspace(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.restore.requestRestoreWorkspace(req.staff!, id, parse(RestoreWorkspaceBody, body));
  }
}

@Module({ imports: [SupportModule], controllers: [RestoreController], providers: [RestoreService] })
export class RestoreModule {}
