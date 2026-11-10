import { Body, Controller, Get, HttpCode, Module, Param, ParseIntPipe, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { EntitlementsService, type Gated, OverrideBody, PreviewBody, ReferBody, RestoreBody, RevokeBody, VersionBody } from './entitlements.service.js';

/** เกินวงเงิน / ต้องอนุมัติ → 202 พร้อมคำขออนุมัติ · ไม่เกิน → 200 พร้อมผล */
async function respond<T extends object>(res: Response, p: Promise<Gated<T>>) {
  const r = await p;
  if ('pendingApproval' in r) res.status(202);
  return r;
}

/** สิทธิ์และขีดจำกัด (O21) · อ่าน: Owner, การเงิน, วิศวกร · เวอร์ชัน: Owner, การเงิน · ปรับเฉพาะราย: Owner, การเงิน, วิศวกร (Rate limit) */
@Controller('ops/entitlements')
export class EntitlementsController {
  constructor(private readonly ent: EntitlementsService) {}

  @Roles('owner', 'finance', 'engineer')
  @Get()
  overview() {
    return this.ent.overview();
  }

  @Roles('owner', 'finance')
  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    return this.ent.preview(parse(PreviewBody, body));
  }

  @Roles('owner', 'finance', 'engineer')
  @Get('versions')
  history() {
    return this.ent.history();
  }

  @Roles('owner', 'finance')
  @Post('versions')
  createVersion(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.ent.createVersion(req.staff!, parse(VersionBody, body)));
  }

  @Roles('owner', 'finance')
  @Post('versions/:version/restore')
  restore(@Req() req: OpsRequest, @Param('version', ParseIntPipe) version: number, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.ent.restore(req.staff!, version, parse(RestoreBody, body)));
  }

  @Roles('owner', 'finance', 'engineer')
  @Post('overrides')
  createOverride(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.ent.createOverride(req.staff!, parse(OverrideBody, body)));
  }

  @Roles('owner', 'finance', 'engineer')
  @Post('overrides/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.ent.revokeOverride(req.staff!, id, parse(RevokeBody, body));
  }

  @Roles('owner', 'finance', 'engineer')
  @Post('near-limit/:workspaceId/refer')
  @HttpCode(200)
  refer(@Req() req: OpsRequest, @Param('workspaceId') id: string, @Body() body: unknown) {
    return this.ent.referToSales(req.staff!, id, parse(ReferBody, body));
  }
}

@Module({ controllers: [EntitlementsController], providers: [EntitlementsService] })
export class EntitlementsModule {}
