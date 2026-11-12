import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { DeletedWorkspaceService } from './deleted-workspace.service.js';
import { IdsBody, PurgeBody, PurgeManyBody, TRASH_TYPES } from './shared.js';
import { RestoreProjectBody, TrashQuery, TrashService } from './trash.service.js';

const TrashType = z.enum(TRASH_TYPES);

/** A41 · ถังขยะของ Workspace (Z1–Z3) · 03-api › 3.8 */
@Controller('w/:ws/trash')
@UseGuards(TenantGuard)
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  /** ถังขยะทั้ง Workspace (Owner / Admin) · type=project|issue|file · จัด "ชุด" งานที่คนเดียวกันลบภายใน 2 นาที */
  @Get()
  list(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() q: unknown) {
    return this.trash.listWorkspace(a, t, parse(TrashQuery, q));
  }

  /** กู้คืนงานหลายงาน (ชุด) · Sub-task ที่ลบพร้อมแม่กลับมาด้วย */
  @Post(['issue\\:restore', 'issue/restore'])
  @HttpCode(200)
  restoreIssues(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.trash.restoreIssues(a, t, parse(IdsBody, body).ids);
  }

  /** กู้คืนไฟล์หลายไฟล์ · โฟลเดอร์เดิมหายแล้วกลับไปที่ราก */
  @Post(['file\\:restore', 'file/restore'])
  @HttpCode(200)
  restoreFiles(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.trash.restoreFiles(a, t, parse(IdsBody, body).ids);
  }

  /** กู้คืนโปรเจกต์ (Project Owner / Workspace Owner / Admin) · Key ซ้ำตอบ 409 project_key_taken · เกินแพ็กเกจตอบ 402 */
  @Post(['project/:id\\:restore', 'project/:id/restore'])
  @HttpCode(200)
  restoreProject(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.trash.restoreProject(a, t, id, parse(RestoreProjectBody, body ?? {}));
  }

  /** ลบถาวรหลายรายการ (Owner · พิมพ์ "ลบถาวร") */
  @Post([':type\\:purge', ':type/purge'])
  @HttpCode(200)
  purgeMany(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('type') type: string, @Body() body: unknown) {
    const input = parse(PurgeManyBody, body);
    return this.trash.purge(a, t, parse(TrashType, type), input.ids, input.confirm);
  }

  /** ลบถาวรทันที (Owner · พิมพ์ "ลบถาวร") · คืนพื้นที่ไฟล์ */
  @Delete(':type/:id')
  purge(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('type') type: string, @Param('id') id: string, @Body() body: unknown) {
    return this.trash.purge(a, t, parse(TrashType, type), [id], parse(PurgeBody, body ?? {}).confirm);
  }
}

/** A41 · ถังขยะของโปรเจกต์ (Z4 · สิทธิ์ project.trash) */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ProjectTrashController {
  constructor(private readonly trash: TrashService) {}

  /** งานและไฟล์ในถังขยะของโปรเจกต์ · กู้คืนผ่าน `w/trash/issue:restore` และ `w/trash/file:restore` */
  @Get('trash')
  list(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('key') key: string, @Query() q: unknown) {
    return this.trash.listProject(a, t, key, parse(TrashQuery, q));
  }
}

/** A41 · Workspace ที่ลบไว้ (Z5) · เส้นทางระดับผู้ใช้เพราะ `w/:ws` ของ Workspace ที่ลบแล้วตอบ 404 */
@Controller('workspaces/:slug/deleted')
export class DeletedWorkspaceController {
  constructor(private readonly deleted: DeletedWorkspaceService) {}

  /** ข้อมูลหน้า Z5 สำหรับสมาชิกทุกคน · Owner ได้ can.restore / can.export */
  @Get()
  info(@Auth() a: AuthInfo, @Param('slug') slug: string) {
    return this.deleted.info(a, slug);
  }

  /** ส่งออกข้อมูลก่อนลบถาวร (Owner) */
  @Post('exports')
  @HttpCode(202)
  requestExport(@Auth() a: AuthInfo, @Param('slug') slug: string) {
    return this.deleted.requestExport(a, slug);
  }

  @Get('exports')
  listExports(@Auth() a: AuthInfo, @Param('slug') slug: string) {
    return this.deleted.listExports(a, slug);
  }

  @Get('exports/:id/download')
  async download(@Auth() a: AuthInfo, @Param('slug') slug: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.deleted.download(a, slug, id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Length': String(f.size), 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(f.stream);
  }
}
