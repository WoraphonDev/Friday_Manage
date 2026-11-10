import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db } from '@friday/db';
import { AppError } from '../common/errors.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { PlanLimits } from '../core/plan-limits.js';
import { assertTokenAllowed, findApiToken } from './api-tokens.js';
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
    // อ่าน api_tokens ก่อนรู้ว่าเป็น Workspace ไหน จึงใช้ SYSTEM_DB (งาน A28)
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly limits: PlanLimits,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);

    // ระบบภายนอก: Authorization: Bearer <api_token> · ไม่ใช้คุกกี้ จึงไม่ต้องตรวจ CSRF
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (bearer) {
      const id = await findApiToken(this.db, bearer);
      if (!id) {
        if (isPublic) return true;
        throw new AppError(401, 'invalid_token', 'API token ไม่ถูกต้อง หมดสิทธิ์ หรือถูกยกเลิกแล้ว');
      }
      if (!isPublic) {
        await assertTokenAllowed(this.db, id, req.method, req.path);
        // ฟีเจอร์ API token และ "API ต่อนาที" ตามแพ็กเกจ (O21) · ตอบ 402 / 429 พร้อม header ให้ระบบภายนอกถอยเอง
        const res = ctx.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
        try {
          const rl = await this.limits.rateLimit(id.workspaceId);
          if (rl.limit !== null) {
            res.setHeader('X-RateLimit-Limit', String(rl.limit));
            res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
          }
        } catch (e) {
          const retry = (e as AppError).details?.retryAfter;
          if (retry) res.setHeader('Retry-After', String(retry));
          throw e;
        }
      }
      req.auth = { userId: id.userId, sessionId: `token:${id.tokenId}` };
      return true;
    }

    // Webhook ขาเข้า (LINE, GitHub, Stripe …) เรียกจากเซิร์ฟเวอร์ภายนอกที่ไม่มีคุกกี้ จึงข้าม CSRF · แต่ละ route ต้องตรวจลายเซ็นของผู้ให้บริการเอง
    // /storage/ = PUT/GET ของที่เก็บไฟล์ในเครื่อง (dev / test) ที่ยืนยันตัวตนด้วย token ใน URL ที่ลงลายมือชื่อแล้ว (งาน A11)
    const isHook = req.path.startsWith('/api/v1/hooks/') || req.path.startsWith('/api/v1/storage/');
    if (!SAFE.has(req.method) && !isHook) {
      const cookie = req.cookies?.[CSRF_COOKIE];
      if (!cookie || cookie !== req.get('x-csrf-token')) {
        throw new AppError(403, 'csrf_failed', 'คำขอไม่ผ่านการตรวจ CSRF · โหลดหน้าใหม่แล้วลองอีกครั้ง');
      }
    }

    const token = req.cookies?.[SESSION_COOKIE];
    const session = token ? await this.sessions.find(token) : null;
    if (session) req.auth = session;
    if (isPublic) return true;
    if (!session) throw new AppError(401, 'unauthenticated', 'กรุณาเข้าสู่ระบบ');
    return true;
  }
}
