import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { BillingService, ProfileBody, QuoteQuery } from './billing.service.js';

@Controller('w/:ws')
@UseGuards(TenantGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('usage')
  usage(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.billing.usage(auth, tenant);
  }

  @Get('billing')
  overview(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.billing.overview(auth, tenant);
  }

  @Get('billing/quote')
  quote(@Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.billing.quote(tenant, parse(QuoteQuery, query));
  }

  @Get('billing/profile')
  getProfile(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.billing.getProfile(auth, tenant);
  }

  @Put('billing/profile')
  putProfile(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.billing.putProfile(auth, tenant, parse(ProfileBody, body));
  }
}
