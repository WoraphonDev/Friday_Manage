import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { z } from 'zod';
import { CommentBody, CommentsService, PageQuery } from './comments.service.js';

@Controller('w/:ws/issues/:issueKey')
@UseGuards(TenantGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('comments')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Query() query: unknown) {
    return this.comments.list(auth, tenant, key, parse(PageQuery, query));
  }

  @Post('comments')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.comments.create(auth, tenant, key, parse(CommentBody, body));
  }

  @Patch('comments/:id')
  edit(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.comments.edit(auth, tenant, key, parse(z.uuid(), id), parse(CommentBody, body));
  }

  @Delete('comments/:id')
  @HttpCode(200)
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string) {
    return this.comments.remove(auth, tenant, key, parse(z.uuid(), id));
  }

  @Get('activity')
  activity(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Query() query: unknown) {
    return this.comments.activity(auth, tenant, key, parse(PageQuery, query));
  }

  @Get('watchers')
  watchers(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.comments.watchers(auth, tenant, key);
  }

  @Post('watch')
  @HttpCode(200)
  watch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.comments.watch(auth, tenant, key, true);
  }

  @Delete('watch')
  @HttpCode(200)
  unwatch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.comments.watch(auth, tenant, key, false);
  }
}
