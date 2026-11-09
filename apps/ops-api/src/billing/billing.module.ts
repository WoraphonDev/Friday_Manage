import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import {
  BillingService,
  CloseBody,
  ContactBody,
  CreateInvoiceBody,
  CreditGrantBody,
  ExportQuery,
  ExtendBody,
  InvoicesQuery,
  RefundBody,
  RevenueQuery,
  SendLinkBody,
  TaxQuery,
  VoidBody,
} from './billing.service.js';

/** เกินวงเงิน → 202 พร้อมคำขออนุมัติ */
async function respond<T extends object>(res: Response, p: Promise<T>) {
  const r = await p;
  if ('pendingApproval' in r) res.status(202);
  return r;
}

/**
 * ใบแจ้งหนี้ ค้างชำระ ภาษี คืนเงิน และรายงานรายได้ (O03 · หน้า Billing / Refunds · B1–B8)
 * ดูได้: การเงิน Owner ผู้ตรวจ · ทำรายการ: การเงิน · ปิดงวด: การเงิน / Owner (แตะ key ซ้ำ)
 */
@Controller('ops')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Roles('finance', 'owner', 'auditor')
  @Get('invoices')
  invoices(@Query() q: unknown) {
    return this.billing.listInvoices(parse(InvoicesQuery, q));
  }
  @Roles('finance')
  @Post('invoices')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.billing.createInvoice(req.staff!, parse(CreateInvoiceBody, body));
  }
  @Roles('finance')
  @Post(['invoices/:id/void', 'invoices/:id\\:void'])
  @HttpCode(200)
  voidInvoice(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.billing.voidInvoice(req.staff!, id, parse(VoidBody, body)));
  }
  @Roles('finance')
  @Post(['invoices/:id/send-link', 'invoices/:id\\:send-link'])
  @HttpCode(200)
  sendLink(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.sendLink(req.staff!, id, parse(SendLinkBody, body ?? {}));
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('overdue')
  overdue() {
    return this.billing.overdue();
  }
  @Roles('finance')
  @Post(['invoices/:id/contact', 'invoices/:id\\:contact'])
  @HttpCode(200)
  contact(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.contact(req.staff!, id, parse(ContactBody, body));
  }
  @Roles('finance')
  @Post(['invoices/:id/extend', 'invoices/:id\\:extend'])
  @HttpCode(200)
  extend(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.extend(req.staff!, id, parse(ExtendBody, body));
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('tax')
  tax(@Query() q: unknown) {
    return this.billing.tax(parse(TaxQuery, q));
  }
  @Roles('finance')
  @Post(['tax-documents/:id/retry', 'tax-documents/:id\\:retry'])
  @HttpCode(200)
  retry(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.billing.retryTaxDocument(req.staff!, id);
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('refunds')
  refunds() {
    return this.billing.refunds();
  }
  @Roles('finance')
  @Post('refunds')
  @HttpCode(200)
  refund(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.billing.requestRefund(req.staff!, parse(RefundBody, body)));
  }
  @Roles('finance')
  @Post('credits')
  @HttpCode(200)
  credit(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.billing.requestCredit(req.staff!, parse(CreditGrantBody, body)));
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('revenue')
  revenue(@Query() q: unknown) {
    return this.billing.revenue(parse(RevenueQuery, q));
  }
  @Roles('finance', 'owner')
  @Reauth()
  @Post(['revenue/close', 'revenue\\:close'])
  @HttpCode(200)
  close(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.billing.close(req.staff!, parse(CloseBody, body));
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('revenue/export')
  async export(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.billing.export(parse(ExportQuery, q));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${r.filename}"`, 'X-Report-Status': r.draft ? 'draft' : 'closed', 'Cache-Control': 'private, no-store' });
    return r.csv;
  }
}

@Module({ controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
