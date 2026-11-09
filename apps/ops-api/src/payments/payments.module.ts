import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { ConfirmBody, OpsPaymentsService, PaymentsQuery, RejectBody } from './ops-payments.service.js';

const stream = (res: Response, f: { stream: NodeJS.ReadableStream; size: number; filename: string }) => {
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size), 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store' });
  return new StreamableFile(f.stream as never);
};

/** ตรวจการชำระเงิน (O03 ขยายเป็นคิวกรณีผิดปกติ) · ดูได้: การเงิน, Owner, ผู้ตรวจ · ตัดสิน: การเงิน */
@Controller('ops')
export class PaymentsController {
  constructor(private readonly payments: OpsPaymentsService) {}

  @Roles('finance', 'owner', 'auditor')
  @Get('payments')
  listPayments(@Query() q: unknown) {
    return this.payments.list(parse(PaymentsQuery, q));
  }
  @Roles('finance', 'owner')
  @Get('payments/:id/slip')
  async slip(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return stream(res, await this.payments.slip(id));
  }
  @Roles('finance')
  @Post(['payments/:id/confirm', 'payments/:id\\:confirm'])
  @HttpCode(200)
  confirm(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.confirm(req.staff!, id, parse(ConfirmBody, body ?? {}));
  }
  @Roles('finance')
  @Post(['payments/:id/reject', 'payments/:id\\:reject'])
  @HttpCode(200)
  reject(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reject(req.staff!, id, parse(RejectBody, body));
  }
  @Roles('finance', 'owner')
  @Get('wht-certificates/:id/file')
  async whtFile(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return stream(res, await this.payments.whtFile(id));
  }
  @Roles('finance')
  @Post(['wht-certificates/:id/confirm', 'wht-certificates/:id\\:confirm'])
  @HttpCode(200)
  confirmWht(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reviewWht(req.staff!, id, 'confirmed', parse(ConfirmBody, body ?? {}).note);
  }
  @Roles('finance')
  @Post(['wht-certificates/:id/reject', 'wht-certificates/:id\\:reject'])
  @HttpCode(200)
  rejectWht(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.reviewWht(req.staff!, id, 'rejected', parse(RejectBody, body).reason);
  }
}

@Module({ controllers: [PaymentsController], providers: [OpsPaymentsService] })
export class PaymentsModule {}
