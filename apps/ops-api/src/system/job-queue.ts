import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import { AppError } from '../errors.js';

/** ชื่อคิวเดียวกับ apps/api (src/queue/jobs.ts) */
const QUEUE_NAME = 'jobs';

/**
 * อ่าน / จัดการคิวงานเบื้องหลังของ API ลูกค้า (BullMQ บน Valkey) · ตั้ง VALKEY_URL และ QUEUE_PREFIX ให้ตรงกับ API
 * ไม่ตั้ง VALKEY_URL = API รันแบบ inline ไม่มีคิว → หน้าจอแสดง "ยังไม่เชื่อมคิว"
 */
@Injectable()
export class JobQueue implements OnModuleDestroy {
  private queue?: Queue;
  private events?: QueueEvents;

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

  /**
   * ส่งงานให้ Worker ของ API ทำแทน แล้วรอผล (เช่น สคริปต์ย้ายงานข้ามโปรเจกต์ · ตรรกะอยู่ที่ API ที่เดียว)
   * ไม่ retry: งานที่เขียนข้อมูลต้องไม่ทำซ้ำเอง · งานล้มเพราะกติกา API ส่ง {code, message, details} มาใน failedReason
   */
  async run<T>(name: string, data: unknown, timeoutMs = 60_000): Promise<T> {
    const q = this.q();
    if (!q) throw new AppError(409, 'queue_not_configured', 'ยังไม่ได้เชื่อมคิวงาน (ตั้ง VALKEY_URL ให้ ops-api และเปิด Worker ของ API)');
    this.events ??= new QueueEvents(QUEUE_NAME, { connection: { url: process.env.VALKEY_URL! }, prefix: process.env.QUEUE_PREFIX || 'friday' });
    await this.events.waitUntilReady();
    const job = await q.add(name, data, { attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 7 * 86400 } });
    try {
      return (await job.waitUntilFinished(this.events, timeoutMs)) as T;
    } catch (e) {
      const reason = (e as Error).message ?? String(e);
      let rule: { code?: string; message?: string; details?: Record<string, unknown> } | null = null;
      try {
        rule = JSON.parse(reason);
      } catch {
        rule = null;
      }
      if (rule?.code && rule.message) throw new AppError(422, rule.code, rule.message, rule.details ?? {});
      if (/timed out/i.test(reason)) throw new AppError(504, 'worker_timeout', 'Worker ของ API ไม่ตอบภายในเวลาที่กำหนด · ตรวจหน้าสถานะระบบ', { jobId: job.id });
      throw new AppError(502, 'job_failed', `งานในคิวล้ม: ${reason.slice(0, 300)}`, { jobId: job.id });
    }
  }

  /** ใช้ใน test เท่านั้น: ต่อคิวเดียวกันเพื่อสร้างงานที่ล้ม */
  raw() {
    return this.q();
  }

  async onModuleDestroy() {
    await this.events?.close();
    await this.queue?.close();
  }
}
