import { Body, Controller, Get, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AbuseSettings } from './rules.js';
import { AbuseService, AddBlockBody, BlocksQuery, CasesQuery, DecideBody, RemoveBlockBody } from './abuse.service.js';

/** ตรวจจับการใช้ผิด (O50) · เห็นและตัดสินได้: Owner, วิศวกร · ทุกการตัดสิน / แก้กฎ / แก้รายชื่อที่ถูกบล็อกต้องแตะกุญแจ */
@Controller('ops/abuse')
export class AbuseController {
  constructor(private readonly abuse: AbuseService) {}

  @Roles('owner', 'engineer')
  @Get('summary')
  summary() {
    return this.abuse.summary();
  }
  @Roles('owner', 'engineer')
  @Get('cases')
  cases(@Query() q: unknown) {
    return this.abuse.cases(parse(CasesQuery, q));
  }
  @Roles('owner', 'engineer')
  @Get('cases/:id')
  get(@Param('id') id: string) {
    return this.abuse.get(id);
  }
  @Roles('owner', 'engineer')
  @Reauth()
  @Post('cases/decide')
  decide(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.abuse.decide(req.staff!, parse(DecideBody, body));
  }
  @Roles('owner', 'engineer')
  @Get('blocks')
  blocks(@Query() q: unknown) {
    return this.abuse.blocks(parse(BlocksQuery, q));
  }
  @Roles('owner', 'engineer')
  @Reauth()
  @Post('blocks')
  addBlock(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.abuse.addBlock(req.staff!, parse(AddBlockBody, body));
  }
  @Roles('owner', 'engineer')
  @Reauth()
  @Post('blocks/:id/remove')
  removeBlock(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.abuse.removeBlock(req.staff!, id, parse(RemoveBlockBody, body).reason);
  }
  @Roles('owner', 'engineer')
  @Get('rules')
  rules() {
    return this.abuse.rules();
  }
  @Roles('owner', 'engineer')
  @Reauth()
  @Put('rules')
  saveRules(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.abuse.saveRules(req.staff!, parse(AbuseSettings, body));
  }
}

@Module({ controllers: [AbuseController], providers: [AbuseService], exports: [AbuseService] })
export class AbuseModule {}
