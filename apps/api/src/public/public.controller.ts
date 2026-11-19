import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Auth, type AuthInfo, Public } from '../common/request.js';
import { parse } from '../common/validate.js';
import { AcceptBody, LegalQuery, LegalType, PublicService } from './public.service.js';
import { ContactSalesBody, ContactSalesLimit, ContactSalesService } from './contact-sales.js';

/** หน้าสาธารณะ (R1, R4) · ไม่ต้องล็อกอิน */
@Controller('public')
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Public()
  @Get('plans')
  @Header('Cache-Control', 'public, max-age=300')
  plans() {
    return this.service.plans();
  }

  @Public()
  @Get('legal')
  @Header('Cache-Control', 'public, max-age=300')
  legalIndex(@Query() query: unknown) {
    return this.service.legalIndex(parse(LegalQuery, query).locale);
  }

  @Public()
  @Get('legal/:type')
  @Header('Cache-Control', 'public, max-age=300')
  legal(@Param('type') type: string, @Query() query: unknown) {
    return this.service.legal(parse(LegalType, type), parse(LegalQuery, query));
  }
}

/** ฟอร์มติดต่อฝ่ายขาย (O54) · ไม่ต้องล็อกอิน (ยังตรวจ CSRF ตามปกติ) · จำกัดต่อ IP */
@Controller('public/contact-sales')
export class ContactSalesController {
  constructor(private readonly sales: ContactSalesService) {}

  @Public()
  @UseGuards(ContactSalesLimit)
  @Post()
  @HttpCode(202)
  submit(@Body() body: unknown, @Req() req: Request) {
    return this.sales.submit(parse(ContactSalesBody, body), req.ip ?? null);
  }
}

/** รับทราบข้อกำหนด · ต้องล็อกอิน */
@Controller('me/legal-acceptances')
export class LegalAcceptancesController {
  constructor(private readonly service: PublicService) {}

  @Get()
  mine(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.service.myAcceptances(auth, parse(LegalQuery, query).locale);
  }

  @Post()
  accept(@Auth() auth: AuthInfo, @Body() body: unknown, @Req() req: Request) {
    return this.service.accept(auth, parse(AcceptBody, body), req.ip ?? null);
  }
}
