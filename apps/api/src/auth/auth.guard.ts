import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/errors.js';
import { type AppRequest, IS_PUBLIC } from '../common/request.js';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from './sessions.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * ทุก endpoint ต้องล็อกอิน ยกเว้นที่ติด @Public()
 * คำขอที่แก้ข้อมูลต้องส่ง header x-csrf-token ให้ตรงกับคุกกี้ fm_csrf (double submit) รวมถึง Login / Sign up
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();

    if (!SAFE.has(req.method)) {
      const cookie = req.cookies?.[CSRF_COOKIE];
      if (!cookie || cookie !== req.get('x-csrf-token')) {
        throw new AppError(403, 'csrf_failed', 'คำขอไม่ผ่านการตรวจ CSRF · โหลดหน้าใหม่แล้วลองอีกครั้ง');
      }
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? await this.sessions.find(token) : null;
    if (session) req.auth = session;
    if (isPublic) return true;
    if (!session) throw new AppError(401, 'unauthenticated', 'กรุณาเข้าสู่ระบบ');
    return true;
  }
}
