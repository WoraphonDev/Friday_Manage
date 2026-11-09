import { Body, Controller, Get, Module, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { BusinessQuery, BusinessService, InfraBody, MarketingBody, MarketingQuery, RatesBody } from './business.service.js';
import { MetricsService } from './metrics.service.js';

/**
 * ภาพรวม (Main) และธุรกิจและกำไร (Business) · O06
 * ภาพรวมเปิดให้พนักงานทุกคน (เห็นงานที่ต้องทำวันนี้) แต่ตัวเลขเงินเฉพาะ Owner / การเงิน / ผู้ตรวจ
 * ตั้งค่าต้นทุน (B9) และค่าการตลาด (B10) เฉพาะ Owner และการเงิน
 */
@Controller('ops')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly business: BusinessService,
  ) {}

  /** ตัวเลขสรุปแบบเดิม (A32) · หน้าเว็บเดิมยังใช้ */
  @Get('metrics')
  getMetrics() {
    return this.metrics.get();
  }
  @Get('overview')
  overview(@Req() req: OpsRequest) {
    return this.business.overview(req.staff!);
  }
  @Roles('owner', 'finance', 'auditor')
  @Get('business')
  getBusiness(@Req() req: OpsRequest, @Query() q: unknown) {
    return this.business.business(parse(BusinessQuery, q), req.staff!);
  }

  @Roles('owner', 'finance', 'auditor')
  @Get('costs')
  costs() {
    return this.business.costs();
  }
  @Roles('owner', 'finance')
  @Put('costs/rates')
  rates(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.business.setRates(req.staff!, parse(RatesBody, body));
  }
  @Roles('owner', 'finance')
  @Put('costs/infra')
  infra(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.business.setInfra(req.staff!, parse(InfraBody, body));
  }
  @Roles('owner', 'finance', 'auditor')
  @Get('marketing-costs')
  marketing(@Query() q: unknown) {
    return this.business.marketing(parse(MarketingQuery, q));
  }
  @Roles('owner', 'finance')
  @Put('marketing-costs')
  setMarketing(@Req() req: OpsRequest, @Body() body: unknown) {
    return this.business.setMarketing(req.staff!, parse(MarketingBody, body));
  }
}

@Module({ controllers: [MetricsController], providers: [MetricsService, BusinessService], exports: [MetricsService, BusinessService] })
export class MetricsModule {}
