import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Redirect, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { GitService, LinkRepoBody, PatchRepoBody } from './git.service.js';

/** Admin Console › Integrations › GitHub (N1) */
@Controller('w/:ws/integrations/git')
@UseGuards(TenantGuard)
export class GitIntegrationsController {
  constructor(private readonly git: GitService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.git.listIntegrations(auth, tenant);
  }

  @Get('install-url')
  installUrl(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.git.installUrl(auth, tenant);
  }

  @Get(':id/repositories')
  repositories(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.git.repositories(auth, tenant, id);
  }

  @Post(':id/sync')
  @HttpCode(200)
  sync(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.git.sync(auth, tenant, id);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.git.disconnect(auth, tenant, id);
  }
}

/** L2 › Integrations: ผูก repository กับโปรเจกต์ + กฎย้ายสถานะ */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ProjectReposController {
  constructor(private readonly git: GitService) {}

  @Get('repositories')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.git.listRepos(auth, tenant, key);
  }

  @Post('repositories')
  link(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.git.linkRepo(auth, tenant, key, parse(LinkRepoBody, body));
  }

  @Patch('repositories/:id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.git.patchRepo(auth, tenant, key, id, parse(PatchRepoBody, body));
  }

  @Delete('repositories/:id')
  unlink(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.git.unlinkRepo(auth, tenant, key, id);
  }
}

/** Commit / PR ที่ผูกกับงาน (หน้า C) */
@Controller('w/:ws/issues/:issueKey')
@UseGuards(TenantGuard)
export class IssueGitController {
  constructor(private readonly git: GitService) {}

  @Get('git')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.git.issueGit(auth, tenant, key);
  }
}

/** Webhook ขาเข้าจาก GitHub · ตรวจลายเซ็นเอง (AuthGuard ข้าม CSRF ให้ path /hooks/) */
@Controller('hooks/github')
export class GithubHooksController {
  constructor(private readonly git: GitService) {}

  @Public()
  @Post()
  @HttpCode(202)
  hook(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string, @Headers('x-github-event') event?: string, @Headers('x-github-delivery') delivery?: string) {
    return this.git.receive(req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), signature, event, delivery);
  }

  /** GitHub redirect เบราว์เซอร์ของผู้ติดตั้งกลับมาที่นี่ (Setup URL ของ App) */
  @Public()
  @Get('setup')
  @Redirect()
  async setup(@Query('installation_id') installationId?: string, @Query('state') state?: string, @Query('setup_action') action?: string, @Query('code') code?: string) {
    return { url: await this.git.setup(installationId ?? '', state ?? '', action, code), statusCode: 302 };
  }
}
