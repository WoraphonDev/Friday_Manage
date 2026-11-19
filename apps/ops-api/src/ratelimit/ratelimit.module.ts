import { Body, Controller, Get, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { EntitlementsModule } from '../entitlements/entitlements.module.js';
import { parse } from '../errors.js';
import { ListQuery, NotifyBody, RateLimitService, TempLimitBody } from './ratelimit.service.js';

/** Rate limit ต่อลูกค้า (O51) · Owner และวิศวกร · ปรับเพดานต้องแตะกุญแจ · เกิน 3 เท่าของแพ็กเกจตอบ 202 พร้อมคำขออนุมัติ */
@Controller('ops/ratelimit')
export class RateLimitController {
  constructor(private readonly rl: RateLimitService) {}

  @Roles('owner', 'engineer')
  @Get('summary')
  summary() {
    return this.rl.summary();
  }
  @Roles('owner', 'engineer')
  @Get('workspaces')
  list(@Query() q: unknown) {
    return this.rl.list(parse(ListQuery, q));
  }
  @Roles('owner', 'engineer')
  @Get('workspaces/:id')
  detail(@Param('id') id: string) {
    return this.rl.detail(id);
  }
  @Roles('owner', 'engineer')
  @Post('workspaces/:id/notify')
  notify(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rl.notify(req.staff!, id, parse(NotifyBody, body ?? {}).note);
  }
  @Roles('owner', 'engineer')
  @Reauth()
  @Post('workspaces/:id/limit')
  async limit(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.rl.tempLimit(req.staff!, id, parse(TempLimitBody, body));
    if ('pendingApproval' in r) res.status(202);
    return r;
  }
}

@Module({ imports: [EntitlementsModule], controllers: [RateLimitController], providers: [RateLimitService] })
export class RateLimitModule {}
