import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { HomeService, MyIssuesQuery } from './home.service.js';

@Controller('w/:ws')
@UseGuards(TenantGuard)
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('home')
  getHome(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.home.home(auth, tenant);
  }

  @Get('my-issues')
  myIssues(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.home.myIssues(auth, tenant, parse(MyIssuesQuery, query));
  }
}
