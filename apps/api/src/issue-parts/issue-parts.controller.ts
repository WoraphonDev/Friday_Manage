import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import {
  ChecklistId, ChecklistQuery, CreateChecklistBody, CreateDependencyBody, DependencyPeerBody,
  IssuePartsService, PatchChecklistBody, ReorderChecklistBody,
} from './issue-parts.service.js';

@Controller('w/:ws/issues/:issueKey')
@UseGuards(TenantGuard)
export class IssuePartsController {
  constructor(private readonly parts: IssuePartsService) {}

  @Get('checklist')
  checklist(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Query() query: unknown) {
    return this.parts.checklist(auth, tenant, key, parse(ChecklistQuery, query).kind);
  }

  @Get('checklist/:id')
  checklistItem(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string) {
    return this.parts.checklistItem(auth, tenant, key, parse(ChecklistId, id));
  }

  @Post('checklist')
  createChecklist(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.parts.createChecklist(auth, tenant, key, parse(CreateChecklistBody, body));
  }

  @Post(['checklist/reorder', 'checklist\\:reorder'])
  @HttpCode(200)
  reorderChecklist(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.parts.reorderChecklist(auth, tenant, key, parse(ReorderChecklistBody, body));
  }

  @Patch('checklist/:id')
  patchChecklist(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.parts.patchChecklist(auth, tenant, key, parse(ChecklistId, id), parse(PatchChecklistBody, body));
  }

  @Delete('checklist/:id')
  @HttpCode(204)
  deleteChecklist(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Param('id') id: string) {
    return this.parts.deleteChecklist(auth, tenant, key, parse(ChecklistId, id));
  }

  @Get('dependencies')
  dependencies(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string) {
    return this.parts.dependencies(auth, tenant, key);
  }

  @Post('dependencies')
  createDependency(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.parts.createDependency(auth, tenant, key, parse(CreateDependencyBody, body));
  }

  @Delete('dependencies')
  deleteDependency(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('issueKey') key: string, @Body() body: unknown) {
    return this.parts.deleteDependency(auth, tenant, key, parse(DependencyPeerBody, body));
  }
}
