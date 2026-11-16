import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Query } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppError, routeLabel, traffic } from '../common/errors.js';
import { Public } from '../common/request.js';

const INTERNAL_PATH = '/api/v1/internal/';

/**
 * token ที่ ops-api ส่งมาอ่านตัวนับ (header `x-ops-metrics-token`) · production ต้องตั้ง OPS_METRICS_TOKEN ทั้งสองฝั่ง
 * dev / test ใช้ค่าคงที่เหมือน token ของ email-feedback
 */
function expectedToken() {
  return process.env.OPS_METRICS_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'dev-ops-metrics');
}

/** นับทุกคำขอเมื่อตอบเสร็จ (สถานะจริงที่ส่งออก รวม 5xx ที่ ErrorFilter ตอบ) · ไม่นับคำขอของ ops-api เอง */
export function countTraffic(req: Request, res: Response, next: NextFunction) {
  if (req.originalUrl.startsWith(INTERNAL_PATH)) return next();
  const start = process.hrtime.bigint();
  res.once('finish', () => traffic.record(routeLabel(req), res.statusCode, Number((process.hrtime.bigint() - start) / 1_000_000n)));
  next();
}

/** endpoint ภายในให้หน้าสถานะระบบของ Friday Ops (S10) · ไม่ผ่าน session ของลูกค้า */
@Controller('internal')
export class InternalMetricsController {
  @Public()
  @Get('traffic')
  traffic(@Headers('x-ops-metrics-token') token?: string, @Query('window') window?: string) {
    const want = expectedToken();
    if (!want) throw new AppError(503, 'metrics_not_configured', 'ยังไม่ได้ตั้ง OPS_METRICS_TOKEN');
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'invalid_token', 'token ไม่ถูกต้อง');
    const n = Number(window ?? 5);
    return traffic.snapshot(Number.isInteger(n) && n >= 1 && n <= 60 ? n : 5);
  }
}
