import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { ApiTokensService, CreateTokenBody, PatchTokenBody } from './api-tokens.service.js';

@Controller('w/:ws/api-tokens')
@UseGuards(TenantGuard)
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.tokens.list(auth, tenant);
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.tokens.create(auth, tenant, parse(CreateTokenBody, body));
  }

  @Patch(':id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.tokens.patch(auth, tenant, id, parse(PatchTokenBody, body));
  }

  @Delete(':id')
  revoke(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.tokens.revoke(auth, tenant, id);
  }
}
