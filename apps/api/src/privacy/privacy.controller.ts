import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CompleteBody, CreateRequestBody, DataRequestsService, ListQuery, PatchRequestBody } from './data-requests.service.js';
import { ExportsService } from './exports.service.js';
import { DeleteWorkspaceBody, WorkspaceLifecycleService } from './lifecycle.service.js';
import { SupportAccessBody, SupportAccessService } from './support-access.service.js';

const zip = (res: Response, filename: string, type: string, size: number) =>
  res.set({ 'Content-Type': type, 'Content-Length': String(size), 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });

/** 03-api › 3.3 · exports, data-requests, support-access, DELETE w/ */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class PrivacyController {
  constructor(
    private readonly exports: ExportsService,
    private readonly requests: DataRequestsService,
    private readonly support: SupportAccessService,
    private readonly lifecycle: WorkspaceLifecycleService,
  ) {}

  @Post('exports')
  @HttpCode(202)
  requestExport(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.exports.request(a, t);
  }
  @Get('exports')
  listExports(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.exports.list(a, t);
  }
  @Get('exports/:id')
  getExport(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.exports.get(a, t, id);
  }
  @Get('exports/:id/download')
  async downloadExport(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.exports.download(a, t, id);
    zip(res, f.filename, 'application/zip', f.size);
    return new StreamableFile(f.stream);
  }

  @Get('data-requests')
  listRequests(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() q: unknown) {
    return this.requests.list(a, t, parse(ListQuery, q));
  }
  @Post('data-requests')
  createRequest(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.requests.create(a, t, parse(CreateRequestBody, body));
  }
  @Patch('data-requests/:id')
  patchRequest(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.requests.patch(a, t, id, parse(PatchRequestBody, body));
  }
  @Post(['data-requests/:id/complete', 'data-requests/:id\\:complete'])
  @HttpCode(200)
  completeRequest(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.requests.complete(a, t, id, parse(CompleteBody, body ?? {}));
  }
  @Get('data-requests/:id/result')
  async requestResult(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.requests.result(a, t, id);
    zip(res, f.filename, 'application/json', f.size);
    return new StreamableFile(f.stream);
  }

  @Get('support-access')
  supportAccess(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.support.get(a, t);
  }
  @Put('support-access')
  putSupportAccess(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.support.put(a, t, parse(SupportAccessBody, body));
  }

  /** ลบ Workspace (Owner) · กู้คืนได้ 30 วันที่ `POST workspaces/:slug/restore` */
  @Delete()
  removeWorkspace(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.lifecycle.remove(a, t, parse(DeleteWorkspaceBody, body));
  }
}

/** เส้นทางระดับผู้ใช้ (Workspace ที่ลบแล้วเข้าผ่าน `w/:ws` ไม่ได้) */
@Controller('workspaces')
export class WorkspaceRecoveryController {
  constructor(private readonly lifecycle: WorkspaceLifecycleService) {}

  @Get('deleted')
  deleted(@Auth() a: AuthInfo) {
    return this.lifecycle.deleted(a);
  }

  @Post([':slug/restore', ':slug\\:restore'])
  @HttpCode(200)
  restore(@Auth() a: AuthInfo, @Param('slug') slug: string) {
    return this.lifecycle.restore(a, slug);
  }
}
