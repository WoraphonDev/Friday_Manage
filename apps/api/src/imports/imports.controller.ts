import { Body, Controller, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { config } from '../config.js';
import { type AppRequest, Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { ImportsService, PatchImportBody } from './imports.service.js';

/** L3 · Import Excel */
@Controller('w/:ws/import-jobs')
@UseGuards(TenantGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** multipart/form-data: file (.xlsx) + mode (create) */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxImportBytes, files: 1 } }))
  upload(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @UploadedFile() file: Express.Multer.File | undefined, @Body('mode') mode = 'create') {
    return this.imports.upload(auth, tenant, file, mode);
  }

  @Get(':id')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.imports.get(auth, tenant, id);
  }

  @Patch(':id')
  patch(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.imports.patch(auth, tenant, id, parse(PatchImportBody, body));
  }

  @Post(':id/commit')
  commit(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Req() req: AppRequest) {
    return this.imports.commit(auth, tenant, id, process.env.APP_URL ?? `${req.protocol}://${req.get('host')}`);
  }
}
