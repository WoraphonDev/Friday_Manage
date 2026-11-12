import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { CategoriesBody, CreateBody, FromTicketBody, HelpService, ListQuery, MissesQuery, PatchBody, PublishBody } from './help.service.js';

/**
 * O35 · ศูนย์ช่วยเหลือ (19 · 19b · X8 · X9) · อ่านได้ทุกบทบาท · เขียน / เผยแพร่เฉพาะ Owner และ Support
 * Ticket ต้นทางของ X8 เปิดให้ Owner / Support เท่านั้น (การเงินไม่เห็นข้อความใน Ticket · 06-ops-roles)
 */
@Controller('ops/help')
export class HelpController {
  constructor(private readonly help: HelpService) {}

  @Get('overview')
  overview(@Req() req: OpsRequest) {
    return this.help.overview(req.staff!);
  }
  @Get('articles')
  list(@Query() q: unknown) {
    return this.help.list(parse(ListQuery, q));
  }
  @Get('misses')
  misses(@Query() q: unknown) {
    return this.help.misses(parse(MissesQuery, q));
  }
  @Get('categories')
  categories() {
    return this.help.categories();
  }
  @Roles('owner', 'support')
  @Put('categories')
  saveCategories(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.help.saveCategories(req.staff!, parse(CategoriesBody, body));
  }
  @Get('articles/:id')
  get(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.help.get(req.staff!, id);
  }
  @Roles('owner', 'support')
  @Post('articles')
  create(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.help.create(req.staff!, parse(CreateBody, body));
  }
  @Roles('owner', 'support')
  @Patch('articles/:id')
  patch(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.help.patch(req.staff!, id, parse(PatchBody, body));
  }
  @Roles('owner', 'support')
  @Post(['articles/:id/publish', 'articles/:id\\:publish'])
  @HttpCode(200)
  publish(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.help.publish(req.staff!, id, parse(PublishBody, body));
  }
  @Roles('owner', 'support')
  @Post(['articles/:id/archive', 'articles/:id\\:archive'])
  @HttpCode(200)
  archive(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.help.archive(req.staff!, id);
  }
  @Roles('owner', 'support')
  @Post(['articles/:id/discard-draft', 'articles/:id\\:discard-draft'])
  @HttpCode(200)
  discard(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.help.discardDraft(req.staff!, id);
  }
  @Roles('owner', 'support')
  @Delete('articles/:id')
  remove(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.help.remove(req.staff!, id);
  }
  @Roles('owner', 'support')
  @Post('articles/:id/versions/:version/restore')
  @HttpCode(200)
  restore(@Req() req: OpsRequest, @Param('id') id: string, @Param('version') version: string) {
    return this.help.restore(req.staff!, id, Number(version));
  }
  @Roles('owner', 'support')
  @Get('from-ticket/:ticketId')
  fromTicket(@Param('ticketId') ticketId: string) {
    return this.help.fromTicket(ticketId);
  }
  @Roles('owner', 'support')
  @Post('from-ticket/:ticketId')
  createFromTicket(@Req() req: OpsRequest, @Param('ticketId') ticketId: string, @Body() body: unknown) {
    return this.help.createFromTicket(req.staff!, ticketId, parse(FromTicketBody, body));
  }
}

@Module({ controllers: [HelpController], providers: [HelpService], exports: [HelpService] })
export class HelpModule {}
