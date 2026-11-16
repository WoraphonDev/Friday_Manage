import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/** Error ตามรูปแบบใน docs/spec/03-api.md › Error */
export class AppError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (what = 'resource') => new AppError(404, 'not_found', `ไม่พบ ${what}`);
export const forbidden = (permission: string) =>
  new AppError(403, 'forbidden', 'ไม่มีสิทธิ์ทำรายการนี้', { permission });

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const requestId = req.id;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown } = {
      code: 'internal_error',
      message: 'เกิดข้อผิดพลาดในระบบ',
    };

    const pg = (err as { cause?: PgError }).cause ?? (err as PgError);
    if (err instanceof AppError) {
      status = err.getStatus();
      body = { code: err.code, message: err.message, details: err.details };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      body = { code: status === 404 ? 'not_found' : 'http_error', message: err.message };
    } else if (pg?.code === '23505') {
      status = 409;
      body = { code: 'conflict', message: 'ข้อมูลซ้ำกับที่มีอยู่', details: { constraint: pg.constraint } };
    } else if (pg?.code === '23514' || pg?.code === '23503') {
      status = 422;
      body = { code: 'rule_violation', message: 'ขัดกับกติกาของข้อมูล', details: { constraint: pg.constraint, detail: pg.detail } };
    } else if (pg?.code === '42501') {
      // RLS ปฏิเสธการเขียน: ไม่บอกรายละเอียดว่ามีข้อมูลอยู่หรือไม่
      status = 403;
      body = { code: 'forbidden', message: 'ไม่มีสิทธิ์ทำรายการนี้' };
    }

    if (status >= 500) this.log.error(`${requestId} ${(err as Error)?.stack ?? err}`);
    res.status(status).json({ error: { ...body, requestId } });
  }
}

// ---------------------------------------------------------------- ตัวนับ 5xx (รอบ 4 · S10)

const MINUTE = 60_000;
/** เก็บย้อนหลัง 60 นาที (ops-api อ่านทุก 30 วินาทีแล้วเก็บ 24 ชม. เอง) */
const KEEP_MINUTES = 60;
/** เวลาตอบต่อนาทีเก็บไม่เกินนี้ (พอสำหรับ p95 · กันหน่วยความจำโตตอนคำขอเยอะ) */
const LATENCY_SAMPLES = 500;

interface MinuteBucket {
  at: number;
  total: number;
  errors: number;
  /** เส้นทางที่ตอบ 5xx เช่น "POST /w/:ws/issues" → จำนวน */
  routes: Map<string, number>;
  ms: number[];
}

/**
 * นับคำขอทั้งหมดและที่ตอบ 5xx เป็นช่องละ 1 นาที (หน้าสถานะระบบของ Friday Ops · Error rate)
 * นับในโปรเซสนี้เท่านั้น: รันหลาย task ต้องรวมจากทุก task หรือย้ายไป CloudWatch ตอนขึ้น AWS (I01) · รีสตาร์ทแล้วเริ่มนับใหม่
 */
export class TrafficCounter {
  private readonly buckets: MinuteBucket[] = [];
  readonly startedAt = Date.now();

  record(route: string, status: number, ms: number, now = Date.now()) {
    const at = now - (now % MINUTE);
    let b = this.buckets.at(-1);
    if (!b || b.at !== at) {
      b = { at, total: 0, errors: 0, routes: new Map(), ms: [] };
      this.buckets.push(b);
      while (this.buckets.length && this.buckets[0].at < at - KEEP_MINUTES * MINUTE) this.buckets.shift();
    }
    b.total++;
    if (b.ms.length < LATENCY_SAMPLES) b.ms.push(ms);
    if (status >= 500) {
      b.errors++;
      b.routes.set(route, (b.routes.get(route) ?? 0) + 1);
    }
  }

  /** สรุปช่วง `windowMin` นาทีล่าสุด + รายนาทีย้อนหลัง 60 นาที (ops-api คำนวณช่วงที่ตั้งเองจากรายนาที) */
  snapshot(windowMin = 5, now = Date.now()) {
    const from = now - windowMin * MINUTE;
    const recent = this.buckets.filter((b) => b.at + MINUTE > from);
    const total = recent.reduce((n, b) => n + b.total, 0);
    const errors = recent.reduce((n, b) => n + b.errors, 0);
    const routes = new Map<string, number>();
    for (const b of recent) for (const [r, n] of b.routes) routes.set(r, (routes.get(r) ?? 0) + n);
    const top = [...routes].sort((a, b) => b[1] - a[1])[0];
    const ms = recent.flatMap((b) => b.ms).sort((a, b) => a - b);
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      windowMin,
      total,
      errors,
      ratePct: total ? Math.round((errors / total) * 10_000) / 100 : null,
      topRoute: top ? { route: top[0], errors: top[1] } : null,
      p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null,
      minutes: this.buckets.map((b) => ({
        at: new Date(b.at).toISOString(),
        total: b.total,
        errors: b.errors,
        topRoute: [...b.routes].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      })),
    };
  }

  reset() {
    this.buckets.length = 0;
  }
}

/** ตัวนับของโปรเซสนี้ (ใช้ร่วมกันระหว่าง middleware กับ endpoint ภายใน) */
export const traffic = new TrafficCounter();

/** เส้นทางแบบ pattern ("POST /w/:ws/issues") ไม่ใช่ URL จริง เพื่อรวมกลุ่มได้และไม่มีข้อมูลลูกค้าใน key */
export function routeLabel(req: Request & { route?: { path?: string } }) {
  const path = typeof req.route?.path === 'string' ? req.route.path.replace(/^\/api\/v1/, '') || '/' : '(ไม่มีเส้นทาง)';
  return `${req.method} ${path}`;
}
