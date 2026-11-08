import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AttachBody, CreateFileBody, DeleteFileBody, FilesService, FolderBody, ListFilesQuery, PatchFileBody, PatchFolderBody, UploadUrlBody, VersionBody } from './files.service.js';

const Id = z.uuid();
/** inline=1: ขอแสดงในหน้าดูตัวอย่าง (มีผลเฉพาะ PDF) */
const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional(), inline: z.enum(['1', 'true']).optional() });
const ConfirmQuery = z.object({ confirm: z.stringbool().optional() });

/** หน้า 8 · Files · ทุก route อยู่ใต้ `w/:ws/projects/:key` · Guest → 403 */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get('files')
  list(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.files.list(auth, tenant, key, parse(ListFilesQuery, query));
  }

  @Post(['files/upload-url', 'files\\:upload-url'])
  @HttpCode(200)
  uploadUrl(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.files.uploadUrl(auth, tenant, key, parse(UploadUrlBody, body));
  }

  @Post('files')
  create(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.files.create(auth, tenant, key, parse(CreateFileBody, body));
  }

  @Get('files/:id')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.files.get(auth, tenant, key, id);
  }

  @Post('files/:id/versions')
  version(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.files.createVersion(auth, tenant, key, id, parse(VersionBody, body));
  }

  @Patch('files/:id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.files.patch(auth, tenant, key, id, parse(PatchFileBody, body));
  }

  @Delete('files/:id')
  remove(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    const confirm = parse(ConfirmQuery, query).confirm;
    return this.files.remove(auth, tenant, key, id, parse(DeleteFileBody, { ...((body as object) ?? {}), ...(confirm === undefined ? {} : { confirm }) }));
  }

  @Post(['files/:id/restore', 'files/:id\\:restore'])
  @HttpCode(200)
  restore(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.files.restore(auth, tenant, key, id);
  }

  /** redirect ไป URL ที่หมดอายุใน 5 นาที */
  @Get('files/:id/download')
  @Redirect()
  async download(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Query() query: unknown) {
    const q = parse(VersionQuery, query);
    return { url: await this.files.download(auth, tenant, key, id, q.version, !!q.inline), statusCode: 302 };
  }

  @Post('files/:id/attachments')
  attach(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.files.attach(auth, tenant, key, id, parse(AttachBody, body));
  }

  @Delete('files/:id/attachments')
  detach(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.files.detach(auth, tenant, key, id, parse(AttachBody, body));
  }

  @Get('folders')
  folders(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.files.folders(auth, tenant, key);
  }

  @Post('folders')
  createFolder(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.files.createFolder(auth, tenant, key, parse(FolderBody, body));
  }

  @Patch('folders/:id')
  patchFolder(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.files.patchFolder(auth, tenant, key, parse(Id, id), parse(PatchFolderBody, body));
  }

  @Delete('folders/:id')
  deleteFolder(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.files.deleteFolder(auth, tenant, key, parse(Id, id));
  }
}
