import { flushSentry, SentryLogger } from './instrument.js';
import type { Express } from 'express';
import { createApp } from './bootstrap.js';
import { config } from './config.js';

const app = await createApp();
app.useLogger(new SentryLogger('Friday', { logLevels: ['error', 'warn'] }));
// Health check ของ Load balancer / ECS: ไม่ผ่าน prefix, auth หรือฐานข้อมูล เพื่อไม่ให้ DB ช้าแล้ว task ถูกฆ่าทั้งชุด
(app.getHttpAdapter().getInstance() as Express).get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, version: process.env.APP_VERSION ?? null });
});
process.once('SIGTERM', () => void flushSentry());
await app.listen(config.port);
console.log(`Friday Manage API · http://localhost:${config.port}/api/v1`);
