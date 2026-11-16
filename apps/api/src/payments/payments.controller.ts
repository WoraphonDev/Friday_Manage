import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors, type RawBodyRequest } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AppError } from '../common/errors.js';
import { InvoicesService, SLIP_MAX_BYTES } from './invoices.service.js';
import { CheckoutBody, PayBody, PaymentsService } from './payments.service.js';

const upload = () => FileInterceptor('file', { limits: { fileSize: SLIP_MAX_BYTES + 1, files: 1 } });
const pdf = (res: Response, f: { filename: string; buffer: Buffer }) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.filename}"`, 'Cache-Control': 'private, no-store' });
  return new StreamableFile(f.buffer);
};
/** `:file` = `<uuid>.pdf` (PDF) หรือ `<uuid>` (JSON) */
const split = (file: string) => (file.endsWith('.pdf') ? { id: file.slice(0, -4), pdf: true } : { id: file, pdf: false });

/** ชำระเงิน (R2) · 03-api › 3.10 · Owner / Admin (`ws.billing`) */
@Controller('w/:ws/billing')
@UseGuards(TenantGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly invoices: InvoicesService,
  ) {}

  @Post('checkout')
  checkout(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return this.payments.checkout(a, t, parse(CheckoutBody, body), key);
  }

  @Get('invoices')
  list(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.invoices.list(a, t);
  }

  @Get('invoices/:file')
  async invoice(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('file') file: string, @Res({ passthrough: true }) res: Response) {
    const f = split(file);
    return f.pdf ? pdf(res, await this.invoices.invoicePdf(a, t, f.id)) : this.invoices.get(a, t, f.id);
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  pay(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.payments.pay(a, t, id, parse(PayBody, body ?? {}));
  }

  @Get('credit-notes/:file')
  async creditNote(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('file') file: string, @Res({ passthrough: true }) res: Response) {
    const f = split(file);
    if (!f.pdf) throw new AppError(404, 'not_found', 'ขอไฟล์ .pdf');
    return pdf(res, await this.invoices.creditNotePdf(a, t, f.id));
  }

  @Get('debit-notes/:file')
  async debitNote(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('file') file: string, @Res({ passthrough: true }) res: Response) {
    const f = split(file);
    if (!f.pdf) throw new AppError(404, 'not_found', 'ขอไฟล์ .pdf');
    return pdf(res, await this.invoices.debitNotePdf(a, t, f.id));
  }

  /** ใบเสนอราคา PDF ตามแพ็กเกจที่เลือก (?plan=&cycle=&wht=&coupon=) · ทุกครั้งที่ขอได้เลข QT- ใหม่ */
  @Get('quotation.pdf')
  async quotation(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    return pdf(res, await this.invoices.quotationPdf(a, t, query));
  }

  @Get('tax-documents/:file')
  async taxDocument(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('file') file: string, @Res({ passthrough: true }) res: Response) {
    const f = split(file);
    if (!f.pdf) throw new AppError(404, 'not_found', 'ขอไฟล์ .pdf');
    return pdf(res, await this.invoices.taxDocumentPdf(a, t, f.id));
  }

  @Post('invoices/:id/slip')
  @UseInterceptors(upload())
  slip(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    return this.invoices.slip(a, t, id, file, body);
  }

  @Post('invoices/:id/wht-certificate')
  @UseInterceptors(upload())
  wht(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.invoices.whtCertificate(a, t, id, file);
  }

  /** หักผ่าน e-Withholding Tax แทนการอัปโหลด 50 ทวิ (รอบ 4 · E11) */
  @Post('invoices/:id/wht-ewht')
  whtEwht(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.whtEwht(a, t, id, body);
  }

  @Post(['subscription/cancel', 'subscription\\:cancel'])
  @HttpCode(200)
  cancel(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.invoices.cancel(a, t);
  }
}

/** Webhook ขาเข้า (03-api › 3.11) · ตรวจลายเซ็นจาก rawBody เองแทน session */
@Controller('hooks')
export class PaymentHooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('stripe')
  @HttpCode(200)
  stripe(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    return this.payments.handleStripe(req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), signature);
  }

  @Public()
  @Post('etax')
  @HttpCode(200)
  etax(@Req() req: RawBodyRequest<Request>, @Headers('x-etax-signature') signature?: string) {
    return this.payments.handleETax(req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), signature);
  }
}
