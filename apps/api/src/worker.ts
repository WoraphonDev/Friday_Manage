// Worker ของคิวงานเบื้องหลัง · โปรเซสแยกจาก API แต่โหลด AppModule เดียวกัน
// ทุก module จึง define งานของตัวเองใน onModuleInit เหมือนตอนรัน API
import { SentryLogger } from './instrument.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { jobsConfigFromEnv, Jobs } from './queue/jobs.js';

// ตรวจก่อนเปิดแอป: โหมด inline ไม่มีอะไรให้ Worker ทำ
if (jobsConfigFromEnv().mode !== 'bullmq') {
  console.error('Worker ต้องใช้ VALKEY_URL (และไม่ตั้ง QUEUE_MODE=inline) · เปิด Valkey ด้วย docker compose up -d valkey หรือ bash scripts/setup-valkey.sh');
  process.exit(1);
}

// Error ของงานเบื้องหลังส่ง GlitchTip ด้วย Logger เดียวกับ API (ปิดอยู่ถ้าไม่ตั้ง SENTRY_DSN)
const ctx = await NestFactory.createApplicationContext(AppModule, { logger: new SentryLogger('Worker', { logLevels: ['error', 'warn'] }) });
// SIGTERM → ปิด Worker หลังงานที่กำลังรันเสร็จ (Jobs.onModuleDestroy)
ctx.enableShutdownHooks();
const jobs = ctx.get(Jobs);
await jobs.startWorker(Number(process.env.WORKER_CONCURRENCY ?? 5));
console.log(`Friday Manage worker · งานตามเวลา ${jobs.scheduled.size} รายการ`);
