import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { EmailBody, FollowupBody, OnboardingService, OverviewQuery } from './onboarding.service.js';

/**
 * Onboarding checklist และลูกค้าที่ติด (O34 · บอร์ด 18 · V5 · V7)
 * Owner และ Support ใช้งาน · การเงินและผู้ตรวจอ่านอย่างเดียว · วิศวกรไม่เห็น (06-ops-roles)
 */
@Controller('ops/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Roles('owner', 'support', 'finance', 'auditor')
  @Get()
  overview(@Query() q: unknown) {
    return this.onboarding.overview(parse(OverviewQuery, q));
  }

  @Roles('owner', 'support', 'finance', 'auditor')
  @Get('workspaces/:id')
  detail(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.onboarding.detail(req.staff!, id);
  }

  @Roles('owner', 'support')
  @Put('workspaces/:id/followup')
  followup(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.onboarding.saveFollowup(req.staff!, id, parse(FollowupBody, body));
  }

  @Roles('owner', 'support')
  @Post('workspaces/:id/email')
  @HttpCode(200)
  email(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.onboarding.sendEmail(req.staff!, id, parse(EmailBody, body));
  }
}

@Module({ controllers: [OnboardingController], providers: [OnboardingService] })
export class OnboardingModule {}
