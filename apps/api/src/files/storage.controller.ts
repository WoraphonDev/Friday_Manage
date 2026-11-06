import { Controller, Get, Header, HttpCode, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../common/errors.js';
import { Public } from '../common/request.js';
import { contentDisposition, LocalStorage, MAX_FILE_BYTES } from './storage.js';

/**
 * ปลายทางของที่เก็บไฟล์ในเครื่อง (dev / test / Codex) แทน S3 presigned URL
 * ยืนยันตัวด้วย token ที่ลงลายมือชื่อและหมดอายุ ไม่ใช้ session จึงข้าม CSRF (ดู AuthGuard)
 * production ตั้ง S3_BUCKET แล้ว route นี้ไม่ถูกใช้
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly local: LocalStorage) {}

  @Public()
  @Put('upload/:token')
  @HttpCode(200)
  async upload(@Param('token') token: string, @Req() req: Request) {
    const claims = this.local.verify('storage-put', token);
    if (!claims) throw new AppError(403, 'invalid_upload_url', 'ลิงก์อัปโหลดไม่ถูกต้องหรือหมดอายุ');
    const size = Number(claims.s);
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new AppError(413, 'file_too_large', 'ไฟล์ใหญ่เกิน 100 MB');
    try {
      await this.local.write(claims.k, req, size);
    } catch (err) {
      const m = (err as Error).message;
      if (m === 'too_large') throw new AppError(413, 'file_too_large', 'ไฟล์ใหญ่กว่าที่แจ้งไว้');
      if (m === 'size_mismatch') throw new AppError(400, 'size_mismatch', 'ขนาดไฟล์ไม่ตรงกับที่แจ้งไว้');
      throw err;
    }
    return { ok: true };
  }

  @Public()
  @Get('download/:token')
  @Header('Cache-Control', 'private, no-store')
  async download(@Param('token') token: string, @Res() res: Response) {
    const claims = this.local.verify('storage-get', token);
    if (!claims) throw new AppError(403, 'invalid_download_url', 'ลิงก์ดาวน์โหลดหมดอายุแล้ว · กดดาวน์โหลดใหม่อีกครั้ง');
    if (!(await this.local.stat(claims.k))) throw new AppError(404, 'not_found', 'ไม่พบไฟล์');
    res.setHeader('content-type', String(claims.m ?? 'application/octet-stream'));
    res.setHeader('content-disposition', contentDisposition(String(claims.n ?? 'file')));
    res.setHeader('x-content-type-options', 'nosniff');
    this.local.read(claims.k).pipe(res);
  }
}
