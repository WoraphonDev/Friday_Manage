import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.use(cookieParser());
  // ไฟล์สัญญาของบัญชีลูกค้า (ช่วง 3) ส่งเป็น PDF ตรง ๆ ไม่เกิน 10 MB · JSON ยังจำกัดตามค่าเริ่มต้น
  app.useBodyParser('raw', { type: 'application/pdf', limit: '10mb' });
  // statement ธนาคาร (CSV / Excel) ส่งเป็นไฟล์ตรง ๆ ไม่เกิน 5 MB (O03 เฟส 2)
  app.useBodyParser('raw', { type: 'application/octet-stream', limit: '5mb' });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // หน้าหลังบ้านไม่ควรถูกฝังใน iframe และไม่ให้ cache ผลที่เป็นข้อมูลลูกค้า
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableShutdownHooks();
  return app;
}
