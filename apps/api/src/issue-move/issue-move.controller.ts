import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { IssueMoveService, MoveBody, PreviewMoveBody } from './issue-move.service.js';

/** ย้ายงานข้ามโปรเจกต์ · ดูก่อนย้าย (ไม่เขียนข้อมูล) แล้วย้ายจริงด้วยการจับคู่ที่เลือก */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class IssueMoveController {
  constructor(private readonly moves: IssueMoveService) {}

  @Post('issues/move/preview')
  @HttpCode(200)
  preview(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.moves.preview(auth, tenant, parse(PreviewMoveBody, body));
  }

  @Post('issues/move')
  @HttpCode(200)
  move(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.moves.move(auth, tenant, parse(MoveBody, body));
  }
}
