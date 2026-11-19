import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CreateDiagramBody, DiagramsService, IssueOptionsQuery, ListDiagramsQuery, LockBody, PatchDiagramBody, SaveContentBody } from './diagrams.service.js';

/** แท็บ Diagram · ทุก route อยู่ใต้ `w/:ws/projects/:key` · Guest Viewer → 403 · แพ็กเกจ Free → 402 */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class DiagramsController {
  constructor(private readonly diagrams: DiagramsService) {}

  @Get('diagrams')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.diagrams.list(auth, tenant, key, parse(ListDiagramsQuery, query));
  }

  @Post('diagrams')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.diagrams.create(auth, tenant, key, parse(CreateDiagramBody, body));
  }

  /** ตัวเลือกช่อง "ผูกกับงาน" */
  @Get('diagram-issue-options')
  issueOptions(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.diagrams.issueOptions(auth, tenant, key, parse(IssueOptionsQuery, query));
  }

  @Get('diagrams/:id')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.diagrams.get(auth, tenant, key, id);
  }

  @Patch('diagrams/:id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.diagrams.patch(auth, tenant, key, id, parse(PatchDiagramBody, body));
  }

  @Put('diagrams/:id/content')
  save(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.diagrams.save(auth, tenant, key, id, parse(SaveContentBody, body));
  }

  @Post('diagrams/:id/lock')
  @HttpCode(200)
  lock(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.diagrams.lock(auth, tenant, key, id, parse(LockBody, body ?? {}));
  }

  @Delete('diagrams/:id/lock')
  unlock(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.diagrams.unlock(auth, tenant, key, id);
  }

  @Delete('diagrams/:id')
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.diagrams.remove(auth, tenant, key, id);
  }

  @Post('diagrams/:id/restore')
  @HttpCode(200)
  restore(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.diagrams.restore(auth, tenant, key, id);
  }
}
