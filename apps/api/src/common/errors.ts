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
