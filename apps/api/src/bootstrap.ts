import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';

/**
 * ETag ของเราเป็น version สำหรับ If-Match ไม่ใช่ตัวตรวจแคช: เพิ่ม Module / ลูกงานแล้ว version หลักคงเดิม
 * ถ้าปล่อยให้แคช Express จะตอบ 304 กับ If-None-Match และ client ได้ข้อมูลเก่า
 * ข้อมูลลูกค้าก็ไม่ควรค้างในแคชกลางทาง · route ที่ตั้ง Cache-Control เอง (ปฏิทิน, หน้าสาธารณะ) ยังทับได้
 */
function noHttpCache(req: Request, res: Response, next: NextFunction) {
  // client ที่ส่ง If-None-Match มาเอง (ไม่สน no-store) ต้องได้ข้อมูลปัจจุบันเสมอ
  delete req.headers['if-none-match'];
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'], rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.use(noHttpCache);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
