import { Body, Controller, Get, Param, Patch, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
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

  /** multipart/form-data: file (.xlsx) + mode (create | update) + projectKey (เมื่อ mode = update) */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxImportBytes, files: 1 } }))
  upload(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @UploadedFile() file: Express.Multer.File | undefined, @Body('mode') mode = 'create', @Body('projectKey') projectKey?: string) {
    return this.imports.upload(auth, tenant, file, mode, projectKey);
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

/** L3 › Export แผนงาน (ไฟล์เดียวกับที่นำเข้าโหมดอัปเดตได้) */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class PlanExportController {
  constructor(private readonly imports: ImportsService) {}

  /** ดาวน์โหลดแผนงานของโปรเจกต์เป็น .xlsx (18 คอลัมน์ + ชีต Holidays) นำเข้ากลับโหมดอัปเดตได้ */
  @Get('export.xlsx')
  async export(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.imports.exportXlsx(auth, tenant, key);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.buffer);
  }
}
