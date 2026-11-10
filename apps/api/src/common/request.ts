import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceRole } from './types.js';

export interface AuthInfo {
  userId: string;
  sessionId: string;
}
export interface TenantInfo {
  workspaceId: string;
  slug: string;
  role: WorkspaceRole;
  /** Workspace ถูกระงับ (C6) · null = ใช้งานปกติ */
  suspension?: { mode: 'read_only' | 'full'; message: string | null } | null;
}
export type AppRequest = Request & { id?: string; auth?: AuthInfo; tenant?: TenantInfo };

export const IS_PUBLIC = 'isPublic';
/** ไม่ต้องล็อกอิน */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().auth!);
export const Tenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().tenant!,
);
