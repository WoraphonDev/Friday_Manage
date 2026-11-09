import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

/** ชื่อคิวเดียวกับ apps/api (src/queue/jobs.ts) */
const QUEUE_NAME = 'jobs';

/**
 * อ่าน / จัดการคิวงานเบื้องหลังของ API ลูกค้า (BullMQ บน Valkey) · ตั้ง VALKEY_URL และ QUEUE_PREFIX ให้ตรงกับ API
 * ไม่ตั้ง VALKEY_URL = API รันแบบ inline ไม่มีคิว → หน้าจอแสดง "ยังไม่เชื่อมคิว"
 */
@Injectable()
export class JobQueue implements OnModuleDestroy {
  private queue?: Queue;

  get configured() {
    return !!process.env.VALKEY_URL;
  }

  private q() {
    if (!process.env.VALKEY_URL) return null;
    this.queue ??= new Queue(QUEUE_NAME, { connection: { url: process.env.VALKEY_URL }, prefix: process.env.QUEUE_PREFIX || 'friday' });
    return this.queue;
  }

  async counts() {
    const q = this.q();
    if (!q) return null;
    return q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async failed(limit = 100) {
    const q = this.q();
    if (!q) return [];
    const jobs = await q.getFailed(0, limit - 1);
    return jobs.map((j) => ({
      id: j.id!,
      name: j.name,
      data: j.data as Record<string, unknown>,
      reason: j.failedReason,
      attempts: j.attemptsMade,
      failedAt: j.finishedOn ? new Date(j.finishedOn) : null,
      createdAt: new Date(j.timestamp),
    }));
  }

  async job(id: string) {
    const q = this.q();
    if (!q) return null;
    return (await q.getJob(id)) ?? null;
  }

  /** ใช้ใน test เท่านั้น: ต่อคิวเดียวกันเพื่อสร้างงานที่ล้ม */
  raw() {
    return this.q();
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }
}
