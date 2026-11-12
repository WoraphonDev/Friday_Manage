import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { LocalStorage, S3Storage } from '../files/storage.js';
import { ArticleQuery, ArticlesQuery, FeedbackBody, HelpArticlesService } from './articles.service.js';
import { HelpRateLimit } from './rate-limit.js';
import { SupportRepliesJob } from './replies.js';
import { CreateTicketBody, HelpTicketsService, ReplyBody, TicketsQuery, UploadBody } from './tickets.service.js';
import { z } from 'zod';

const Locale = z.object({ locale: z.enum(['th', 'en']).default('th') });

/**
 * ศูนย์ช่วยเหลือ (X1–X4 · หน้าสาธารณะ /help) · ไม่ต้องเข้าสู่ระบบ แต่ถ้าล็อกอินอยู่จะเห็นบทความ "เฉพาะผู้เข้าสู่ระบบ" ด้วย
 * จำกัดอัตราเรียกต่อ IP (HelpRateLimit)
 */
@Controller('help')
@UseGuards(HelpRateLimit)
export class HelpController {
  constructor(private readonly articles: HelpArticlesService) {}

  /** หมวดของศูนย์ช่วยเหลือพร้อมจำนวนบทความ */
  @Public()
  @Get('categories')
  categories(@Auth() auth: AuthInfo | undefined, @Query() q: unknown) {
    return this.articles.listCategories(auth, parse(Locale, q).locale);
  }

  /** บทความ: ค้นหา (`q`) · ตามหมวด · แนะนำตามหน้าในแอป (`route`) · ยอดนิยม */
  @Public()
  @Get('articles')
  list(@Auth() auth: AuthInfo | undefined, @Query() q: unknown) {
    return this.articles.list(auth, parse(ArticlesQuery, q));
  }

  /** หน้าบทความพร้อมบทความที่เกี่ยวข้อง · นับยอดอ่าน */
  @Public()
  @Get('articles/:slug')
  get(@Auth() auth: AuthInfo | undefined, @Param('slug') slug: string, @Query() q: unknown) {
    return this.articles.get(auth, slug, parse(ArticleQuery, q));
  }

  /** โหวตบทความช่วยได้ / ไม่ช่วย พร้อมความเห็น (ไม่เก็บผู้โหวต) */
  @Public()
  @Post(['articles/:slug/feedback', 'articles/:slug\\:feedback'])
  @HttpCode(200)
  feedback(@Auth() auth: AuthInfo | undefined, @Param('slug') slug: string, @Body() body: unknown) {
    return this.articles.feedback(auth, slug, parse(FeedbackBody, body));
  }
}

/** Ticket ของลูกค้า (X5, X6, T12) · Guest เปิด Ticket ไม่ได้ · ของทั้ง Workspace เฉพาะ Owner / Admin */
@Controller('w/:ws/support')
@UseGuards(TenantGuard)
export class SupportTicketsController {
  constructor(private readonly tickets: HelpTicketsService) {}

  /** รายการ Ticket ของฉัน / ทั้ง Workspace พร้อม SLA ตามแพ็กเกจ */
  @Get('tickets')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() q: unknown) {
    return this.tickets.list(auth, tenant, parse(TicketsQuery, q));
  }

  /** เปิด Ticket ถึงทีม Friday (ช่องทาง in_app) · คำนวณ SLA ตามกฎการแจกงาน · อีเมลยืนยันพร้อมเลข */
  @Post('tickets')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.tickets.create(auth, tenant, parse(CreateTicketBody, body));
  }

  /** ขอลิงก์อัปโหลดไฟล์แนบ (ไม่เกิน 10 MB) · ส่ง uploadToken กลับมาพร้อม Ticket หรือข้อความ */
  @Post('attachments')
  upload(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.tickets.uploadUrl(auth, tenant, parse(UploadBody, body));
  }

  /** รายละเอียด Ticket และข้อความ (ไม่รวมบันทึกภายในของทีม) */
  @Get('tickets/:id')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.tickets.get(auth, tenant, id);
  }

  /** ตอบใน Ticket · เรื่องที่แก้แล้วไม่เกินกำหนดเปิดใหม่อัตโนมัติ */
  @Post('tickets/:id/messages')
  reply(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.reply(auth, tenant, id, parse(ReplyBody, body));
  }

  /** ปิดเรื่อง ("แก้แล้ว ขอบคุณ") */
  @Post(['tickets/:id/close', 'tickets/:id\\:close'])
  @HttpCode(200)
  close(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.tickets.close(auth, tenant, id);
  }

  /** เปิดเรื่องอีกครั้ง ("ยังพบปัญหาอยู่") ภายในกำหนดหลังปิด */
  @Post(['tickets/:id/reopen', 'tickets/:id\\:reopen'])
  @HttpCode(200)
  reopen(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.tickets.reopen(auth, tenant, id);
  }
}

/** A44 · ศูนย์ช่วยเหลือ และ Ticket จากในแอปลูกค้า (docs/tasks/A44-help-center-api.md) */
@Module({
  controllers: [HelpController, SupportTicketsController],
  providers: [HelpArticlesService, HelpTicketsService, HelpRateLimit, SupportRepliesJob, LocalStorage, S3Storage],
})
export class HelpModule {}
