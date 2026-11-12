import { Body, Controller, Get, HttpCode, Module, Param, Post, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AnnouncementsService, AudienceBody, CancelBody, CreateBody, TestBody } from './announcements.service.js';

/**
 * ประกาศถึงลูกค้าที่เลือก (O24 · C8) · เฉพาะ Owner ของทีม Friday (เมนู "ประกาศถึงลูกค้า" ใน Sidebar)
 * แทน CRUD ประกาศแบบเดิมของ A32 ที่อยู่ใน flags (ตั้ง sent_at อย่างเดียว ไม่ได้ส่งจริง)
 */
@Controller('ops')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Roles('owner')
  @Get('announcements')
  list() {
    return this.announcements.list();
  }

  @Roles('owner')
  @Get('announcements/:id')
  one(@Param('id') id: string) {
    return this.announcements.one(id);
  }

  /** นับผู้รับก่อนส่ง */
  @Roles('owner')
  @Post('announcements/audience')
  @HttpCode(200)
  audience(@Body() body: unknown) {
    return this.announcements.audience(parse(AudienceBody, body));
  }

  @Roles('owner')
  @Post('announcements/test')
  @HttpCode(200)
  test(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.announcements.test(req.staff!, parse(TestBody, body));
  }

  @Roles('owner')
  @Post('announcements')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.announcements.create(req.staff!, parse(CreateBody, body));
  }

  @Roles('owner')
  @Post('announcements/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.announcements.cancel(req.staff!, id, parse(CancelBody, body ?? {}));
  }
}

@Module({ controllers: [AnnouncementsController], providers: [AnnouncementsService], exports: [AnnouncementsService] })
export class AnnouncementsModule {}
