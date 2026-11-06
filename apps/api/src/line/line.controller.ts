import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { LineService, PutLineBody, WorkspaceBody } from './line.service.js';

/** Admin Console › ช่องทางแจ้งเตือน › LINE OA (N1) · Owner / Admin เท่านั้น */
@Controller('w/:ws/channels')
@UseGuards(TenantGuard)
export class LineChannelController {
  constructor(private readonly line: LineService) {}

  @Get('line-oa')
  get(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.line.getConfig(auth, tenant);
  }

  @Put('line-oa')
  put(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.line.putConfig(auth, tenant, parse(PutLineBody, body));
  }

  @Post(['line-oa/test', 'line-oa\\:test'])
  @HttpCode(200)
  test(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.line.testConfig(auth, tenant);
  }

  @Get('line-groups')
  groups(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.line.groups(auth, tenant);
  }
}

/** Profile › การแจ้งเตือน › ผูก LINE (I) */
@Controller('me')
export class MeLineController {
  constructor(private readonly line: LineService) {}

  @Get('line')
  status(@Auth() auth: AuthInfo) {
    return this.line.myStatus(auth);
  }

  @Post('line/link-code')
  linkCode(@Auth() auth: AuthInfo) {
    return this.line.createLinkCode(auth);
  }

  @Delete('line')
  unlink(@Auth() auth: AuthInfo) {
    return this.line.unlink(auth);
  }

  @Post(['line/test', 'line\\:test'])
  @HttpCode(200)
  test(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.line.testMine(auth, parse(WorkspaceBody, body).workspace);
  }
}

/** Webhook ขาเข้าจาก LINE · แต่ละ Workspace ใช้ URL ของตัวเอง เพราะ Channel secret ที่ใช้ตรวจลายเซ็นต่างกัน */
@Controller('hooks/line')
export class LineHookController {
  constructor(private readonly line: LineService) {}

  @Public()
  @Post(':workspaceId')
  @HttpCode(200)
  hook(@Param('workspaceId') workspaceId: string, @Req() req: RawBodyRequest<Request>, @Headers('x-line-signature') signature?: string) {
    // rawBody เปิดไว้ใน bootstrap · ไม่มี (เช่น รันนอก bootstrap) ใช้ JSON ที่ parse แล้วแปลงกลับ
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    return this.line.handleWebhook(workspaceId, raw, signature);
  }
}
