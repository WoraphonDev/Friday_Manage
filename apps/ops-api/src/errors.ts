import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends HttpException {
  constructor(status: number, readonly code: string, message: string, readonly details?: unknown) {
    super({ code, message, details }, status);
  }
}

const log = new Logger('Ops');

/** รูปแบบ error เดียวกับ API ลูกค้า: `{ error: { code, message, details? } }` */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof ZodError) return void res.status(400).json({ error: { code: 'validation_failed', message: 'ข้อมูลไม่ถูกต้อง', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: String(body) };
      return void res.status(err.getStatus()).json({ error: { code: o.code ?? (err.getStatus() === 404 ? 'not_found' : 'error'), message: o.message ?? err.message, ...(o.details !== undefined ? { details: o.details } : {}) } });
    }
    // drizzle ห่อ error ของ pg ไว้ใน cause
    const raw = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const e = raw.cause?.code ? raw.cause : raw;
    // เงื่อนไข / ข้อกำหนดของฐานข้อมูลที่ผู้เรียกทำผิด (เช่นกฎ 2 คน ใน support_sessions)
    if (e.code === '23514' || e.code === '23505' || e.code === '23503') return void res.status(409).json({ error: { code: 'conflict', message: 'ข้อมูลขัดกับข้อกำหนด', details: e.message } });
    log.error(e.message ?? String(err));
    res.status(500).json({ error: { code: 'internal_error', message: 'เกิดข้อผิดพลาดภายในระบบ' } });
  }
}

export function parse<T>(schema: { parse(v: unknown): T }, value: unknown): T {
  return schema.parse(value);
}
