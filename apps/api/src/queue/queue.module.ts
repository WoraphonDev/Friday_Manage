import { Global, Module } from '@nestjs/common';
import { Jobs } from './jobs.js';

/**
 * คิวงานเบื้องหลัง (BullMQ + Valkey) · Global เพื่อให้ทุก module inject `Jobs` ได้โดยไม่ต้อง import
 * ลงทะเบียนงานใน onModuleInit ของ module ตัวเอง: `jobs.define(...)` แล้ว `jobs.every(...)` ถ้าเป็นงานตามเวลา
 */
@Global()
@Module({
  providers: [Jobs],
  exports: [Jobs],
})
export class QueueModule {}
