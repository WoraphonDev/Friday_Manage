import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AccountingService, AccountingSettingsBody, EXPORT_TYPES, ExportZipQuery, SendExportBody } from './accounting.service.js';
import {
  BillingService,
  CloseBody,
  ContactBody,
  CreateInvoiceBody,
  CreditGrantBody, CreditLedgerQuery, CreditRefundBody,
  DebitNoteBody,
  ExportQuery,
  ExtendBody,
  InvoicesQuery,
  OverdueQuery,
  RefundsQuery,
  RefundBody,
  ReplaceTaxDocBody,
  RevenueQuery,
  SalesReportQuery,
  SendLinkBody,
  VoidBody,
} from './billing.service.js';
import { kindFromPath, ManualCancelBody, RequestInfoBody, RetryETaxBody, TaxQuery, TaxService } from './tax.service.js';
import { EwhtImportBody, WhtCloseBody, WhtRequestBody, WhtService } from './wht.service.js';
import { z } from 'zod';

/** ไฟล์เอกสาร (PDF / Excel) · ไม่เก็บในแคชของเบราว์เซอร์ */
function file(res: Response, f: { filename: string; buffer: Buffer }, contentType: string, disposition: 'inline' | 'attachment' = 'inline') {
  res.set({ 'Content-Type': contentType, 'Content-Disposition': `${disposition}; filename="${f.filename}"`, 'Cache-Control': 'private, no-store' });
  return new StreamableFile(f.buffer);
}
const PDF = 'application/pdf';

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
  constructor(
    private readonly billing: BillingService,
    private readonly taxes: TaxService,
    private readonly wht: WhtService,
    private readonly accounting: AccountingService,
  ) {}

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

  @Roles('finance')
  @Post(['invoices/:id/debit-note', 'invoices/:id\\:debit-note'])
  @HttpCode(200)
  debitNote(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.issueDebitNote(req.staff!, id, parse(DebitNoteBody, body));
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('invoices/:id/pdf')
  async invoicePdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.billing.documentPdf('invoice', id), PDF);
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('credit-notes/:id/pdf')
  async creditNotePdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.billing.documentPdf('credit_note', id), PDF);
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('debit-notes/:id/pdf')
  async debitNotePdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.billing.documentPdf('debit_note', id), PDF);
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('overdue')
  overdue(@Query() q: unknown) {
    return this.billing.overdue(parse(OverdueQuery, q));
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

  // ---------------------------------------------------------------- แท็บภาษี (รอบ 4 · E1–E4)
  @Roles('finance', 'owner', 'auditor')
  @Get('tax')
  tax(@Query() q: unknown) {
    return this.taxes.overview(parse(TaxQuery, q));
  }
  /** ประวัติ e-Tax ทั้งเดือน */
  @Roles('finance', 'owner', 'auditor')
  @Get('etax')
  etaxHistory(@Query() q: unknown) {
    return this.taxes.history(parse(TaxQuery, q));
  }
  /** E2 · รายละเอียดเอกสาร + ลำดับเหตุการณ์ (:kind = tax-document · credit-note · debit-note) */
  @Roles('finance', 'owner', 'auditor')
  @Get('etax/:kind/:id')
  etaxDetail(@Param('kind') kind: string, @Param('id') id: string) {
    return this.taxes.detail(kindFromPath(kind), id);
  }
  /** ส่งใหม่ / แจ้งอีกครั้ง (body.action = issue · cancel) */
  @Roles('finance')
  @Post(['etax/:kind/:id/retry', 'etax/:kind/:id\\:retry'])
  @HttpCode(200)
  etaxRetry(@Req() req: OpsRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
    return this.taxes.retry(req.staff!, kindFromPath(kind), id, parse(RetryETaxBody, body ?? {}).action);
  }
  @Roles('finance')
  @Post(['etax/:kind/:id/check', 'etax/:kind/:id\\:check'])
  @HttpCode(200)
  etaxCheck(@Req() req: OpsRequest, @Param('kind') kind: string, @Param('id') id: string) {
    return this.taxes.check(req.staff!, kindFromPath(kind), id);
  }
  /** E4 · ยกเลิกที่ผู้ให้บริการแล้ว (แตะกุญแจ) */
  @Roles('finance')
  @Reauth()
  @Post(['etax/:kind/:id/cancel-manual', 'etax/:kind/:id\\:cancel-manual'])
  @HttpCode(200)
  etaxManualCancel(@Req() req: OpsRequest, @Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
    return this.taxes.manualCancel(req.staff!, kindFromPath(kind), id, parse(ManualCancelBody, body));
  }
  /** ส่งใหม่ (ชื่อเดิม) */
  @Roles('finance')
  @Post(['tax-documents/:id/retry', 'tax-documents/:id\\:retry'])
  @HttpCode(200)
  retry(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.taxes.retry(req.staff!, 'tax_document', id, 'issue');
  }
  /** ขอข้อมูลใหม่: อีเมลผู้ติดต่อด้านบัญชีให้แก้ข้อมูลออกใบกำกับ */
  @Roles('finance')
  @Post(['tax-documents/:id/request-info', 'tax-documents/:id\\:request-info'])
  @HttpCode(200)
  requestInfo(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.taxes.requestInfo(req.staff!, id, parse(RequestInfoBody, body ?? {}));
  }

  // ---------------------------------------------------------------- 50 ทวิ (E7–E9)
  @Roles('finance', 'owner', 'auditor')
  @Get('wht/:invoiceId')
  whtDetail(@Param('invoiceId') id: string) {
    return this.wht.detail(id);
  }
  @Roles('finance')
  @Post(['wht/:invoiceId/request', 'wht/:invoiceId\\:request'])
  @HttpCode(200)
  whtRequest(@Req() req: OpsRequest, @Param('invoiceId') id: string, @Body() body: unknown) {
    return this.wht.request(req.staff!, id, parse(WhtRequestBody, body));
  }
  @Roles('finance')
  @Post(['wht/:invoiceId/close', 'wht/:invoiceId\\:close'])
  @HttpCode(200)
  whtClose(@Req() req: OpsRequest, @Param('invoiceId') id: string, @Body() body: unknown) {
    return this.wht.close(req.staff!, id, parse(WhtCloseBody, body));
  }
  @Roles('finance')
  @Post('wht-ewht/import')
  @HttpCode(200)
  ewhtImport(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.wht.importEwht(req.staff!, parse(EwhtImportBody, body));
  }

  @Roles('finance')
  @Post(['tax-documents/:id/replace', 'tax-documents/:id\\:replace'])
  @HttpCode(200)
  replace(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.billing.replaceTaxDocument(req.staff!, id, parse(ReplaceTaxDocBody, body));
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('tax-documents/:id/pdf')
  async taxDocumentPdf(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.billing.documentPdf('tax_document', id), PDF);
  }

  @Roles('finance', 'owner', 'auditor')
  @Get('refunds')
  refunds(@Query() q: unknown) {
    return this.billing.refunds(parse(RefundsQuery, q));
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

  @Roles('finance', 'owner', 'auditor', 'support')
  @Get('credits')
  creditLedger(@Query() q: unknown) {
    return this.billing.creditLedger(parse(CreditLedgerQuery, q));
  }
  @Roles('finance')
  @Post(['credits/refund', 'credits\\:refund'])
  @HttpCode(200)
  creditRefund(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.billing.requestCreditRefund(req.staff!, parse(CreditRefundBody, body)));
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
  async close(@Req() req: OpsRequest, @Body() body: unknown) {
    const r = await this.billing.close(req.staff!, parse(CloseBody, body));
    // ตั้งไว้ "รอจนปิดงวด แล้วส่งทันทีที่ปิด" → ส่งให้สำนักงานบัญชีเลย (ล้มไม่ทำให้การปิดงวดล้ม · งานรายชั่วโมงลองต่อ)
    void this.accounting.autoSendExport().catch(() => null);
    return r;
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('revenue/export/delivery')
  delivery() {
    return this.accounting.delivery();
  }
  @Roles('finance', 'owner')
  @Post(['revenue/export/send', 'revenue/export\\:send'])
  @HttpCode(200)
  send(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.accounting.sendExport(req.staff!, parse(SendExportBody, body ?? {}));
  }
  /** เอกสารภาษีทั้งเดือน ZIP (?scope=all = ดาวน์โหลดทั้งหมด รวมรายงานและ CSV) */
  @Roles('finance', 'owner', 'auditor')
  @Get('revenue/export/zip')
  async exportZip(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.accounting.zip(parse(ExportZipQuery, q));
    res.set('X-Report-Status', r.draft ? 'draft' : 'closed');
    return file(res, r, 'application/zip', 'attachment');
  }
  /** E6 · ตั้งค่าผู้รับและวันส่ง */
  @Roles('finance', 'owner', 'auditor')
  @Get('accounting/settings')
  accountingSettings() {
    return this.accounting.settings();
  }
  @Roles('finance', 'owner')
  @Put('accounting/settings')
  saveAccountingSettings(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.accounting.saveSettings(req.staff!, parse(AccountingSettingsBody, body));
  }
  /** ทดลองส่งถึงอีเมลของฉัน */
  @Roles('finance', 'owner')
  @Post(['accounting/settings/test', 'accounting/settings\\:test'])
  @HttpCode(200)
  testAccounting(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.accounting.test(req.staff!, parse(z.object({ types: z.array(z.enum(EXPORT_TYPES)).min(1).max(3).optional() }).strict(), body ?? {}).types);
  }
  /** รายงานภาษีขายรายเดือน (?month=YYYY-MM&format=pdf|xlsx) */
  @Roles('finance', 'owner', 'auditor')
  @Get('revenue/sales-report')
  async salesReport(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    const query = parse(SalesReportQuery, q);
    const r = await this.billing.salesReport(query);
    res.set('X-Report-Status', r.draft ? 'draft' : 'closed');
    return file(res, r, query.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : PDF, 'attachment');
  }
  @Roles('finance', 'owner', 'auditor')
  @Get('revenue/export')
  async export(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.billing.export(parse(ExportQuery, q));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${r.filename}"`, 'X-Report-Status': r.draft ? 'draft' : 'closed', 'Cache-Control': 'private, no-store' });
    return r.csv;
  }
}

@Module({ controllers: [BillingController], providers: [BillingService, TaxService, WhtService, AccountingService], exports: [BillingService, TaxService, WhtService, AccountingService] })
export class BillingModule {}
