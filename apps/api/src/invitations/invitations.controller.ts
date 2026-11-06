import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { type AppRequest, Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateInvitationsBody, InvitationsService } from './invitations.service.js';

const appUrl = (req: AppRequest) => process.env.APP_URL ?? `${req.protocol}://${req.get('host')}`;

@Controller('w/:ws/invitations')
@UseGuards(TenantGuard)
export class WorkspaceInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.invitations.listPending(auth, tenant);
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown, @Req() req: AppRequest) {
    return this.invitations.create(auth, tenant, parse(CreateInvitationsBody, body), appUrl(req));
  }

  @Post([':id/resend', ':id\\:resend'])
  @HttpCode(200)
  resend(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Req() req: AppRequest) {
    return this.invitations.resend(auth, tenant, id, appUrl(req));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.invitations.revoke(auth, tenant, id);
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  accept(@Auth() auth: AuthInfo, @Param('token') token: string) {
    return this.invitations.accept(auth, token);
  }

  @Post(':token/decline')
  @HttpCode(200)
  decline(@Auth() auth: AuthInfo, @Param('token') token: string) {
    return this.invitations.decline(auth, token);
  }
}
