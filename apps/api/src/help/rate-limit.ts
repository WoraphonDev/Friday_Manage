import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../common/errors.js';
import type { AppRequest } from '../common/request.js';

const WINDOW_MS = 60_000;
/** ต่อ IP ต่อนาที · อ่านบทความ / ค้นหาพิมพ์แล้วยิงหลายครั้ง จึงเผื่อไว้มาก · โหวตเข้มกว่าเพราะเขียนข้อมูล */
export const HELP_LIMITS = { read: 120, write: 20 } as const;

/**
 * จำกัดอัตราเรียกของ endpoint ศูนย์ช่วยเหลือที่ไม่ต้องเข้าสู่ระบบ (A44) · นับในหน่วยความจำของโปรเซส
 * พอสำหรับกันสคริปต์ยิงซ้ำจาก IP เดียว · หลายเครื่องหลัง load balancer แต่ละเครื่องนับแยกกัน (ยอมรับได้สำหรับข้อมูลสาธารณะ)
 */
@Injectable()
export class HelpRateLimit implements CanActivate {
  private readonly hits = new Map<string, { at: number; n: number }>();

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const kind = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    const key = `${kind}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.at >= WINDOW_MS) this.hits.delete(k);
    const cur = this.hits.get(key);
    const entry = !cur || now - cur.at >= WINDOW_MS ? { at: now, n: 0 } : cur;
    entry.n++;
    this.hits.set(key, entry);
    if (entry.n > HELP_LIMITS[kind]) {
      const retryAfter = Math.max(1, Math.ceil((entry.at + WINDOW_MS - now) / 1000));
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new AppError(429, 'rate_limited', `เรียกบ่อยเกินไป · ลองใหม่ใน ${retryAfter} วินาที`, { retryAfter });
    }
    return true;
  }

  /** test ล้างตัวนับ */
  reset() {
    this.hits.clear();
  }
}
