import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { config } from '../config.js';

export { UnrecoverableError };

/**
 * inline : รันงานทันทีในโปรเซสเดียว (test, Codex, เครื่องที่ไม่มี Valkey) · ไม่มีงานตามเวลา
 * bullmq : API ส่งงานเข้า Valkey แล้ว Worker (src/worker.ts) เป็นผู้รัน
 */
export type QueueMode = 'inline' | 'bullmq';

export interface JobsConfig {
  mode: QueueMode;
  url?: string;
  /** แยก key ของแต่ละสภาพแวดล้อมที่ใช้ Valkey ร่วมกัน */
  prefix: string;
  /** รอก่อน retry ครั้งแรก (ms) แล้วเพิ่มเป็นเท่าตัว · โหมด inline retry ทันที */
  backoffMs: number;
}

export const JOBS_CONFIG = Symbol('JOBS_CONFIG');

export function jobsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const url = env.VALKEY_URL || undefined;
  const explicit = env.QUEUE_MODE || undefined;
  if (explicit && explicit !== 'inline' && explicit !== 'bullmq') throw new Error(`QUEUE_MODE ต้องเป็น inline หรือ bullmq (ได้ ${explicit})`);
  // test ใช้ inline เสมอแม้ตั้ง VALKEY_URL ไว้ เพื่อให้ผลไม่ขึ้นกับ Worker ภายนอก
  const isTest = env.NODE_ENV === 'test' || Boolean(env.VITEST);
  const mode = (explicit as QueueMode | undefined) ?? (url && !isTest ? 'bullmq' : 'inline');
  if (mode === 'bullmq' && !url) throw new Error('QUEUE_MODE=bullmq ต้องตั้ง VALKEY_URL');
  return { mode, url, prefix: env.QUEUE_PREFIX || 'friday', backoffMs: 2000 };
}

export interface JobContext {
  id: string;
  name: string;
  /** ครั้งที่กำลังรัน เริ่มที่ 1 · handler ใช้ประกอบการกันทำซ้ำได้ */
  attempt: number;
}

/** handler ต้อง idempotent: รันซ้ำด้วยข้อมูลเดิมแล้วผลเหมือนเดิม เพราะงานถูก retry ได้ */
export type JobHandler<T = unknown> = (data: T, ctx: JobContext) => unknown;

export interface EnqueueOptions {
  /** กันงานซ้ำ: ถ้างาน id เดียวกันยังอยู่ในคิว (หรือกำลังรัน) จะไม่เพิ่มอีก · ห้ามมี ':' */
  jobId?: string;
  /** โหมด inline ไม่รอ รันทันที */
  delayMs?: number;
}

/** ครั้งแรก + retry 3 ครั้ง */
export const JOB_ATTEMPTS = 4;
const QUEUE_NAME = 'jobs';
// cron 5 ช่อง (นาที ชั่วโมง วัน เดือน วันในสัปดาห์) หรือ 6 ช่อง (มีวินาทีนำหน้า)
const CRON = /^\S+(\s+\S+){4,5}$/;

/**
 * คิวงานเบื้องหลัง · module อื่นเรียก define / every ใน onModuleInit ของตัวเอง และ enqueue หลัง commit
 * (โหมด inline รัน handler ทันที ถ้า enqueue ในธุรกรรม handler จะยังไม่เห็นข้อมูลที่ยังไม่ commit)
 */
@Injectable()
export class Jobs implements OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly cfg: JobsConfig;
  private queue?: Queue;
  private worker?: Worker;

  constructor(@Optional() @Inject(JOBS_CONFIG) cfg?: JobsConfig) {
    this.cfg = cfg ?? jobsConfigFromEnv();
  }

  get mode(): QueueMode {
    return this.cfg.mode;
  }

  /** งานตามเวลาที่ลงทะเบียนไว้ (ชื่อ → cron) */
  get scheduled(): ReadonlyMap<string, string> {
    return this.schedules;
  }

  define<T>(name: string, handler: JobHandler<T>) {
    if (this.handlers.has(name)) throw new Error(`งาน ${name} ถูก define ซ้ำ`);
    this.handlers.set(name, handler as JobHandler);
  }

  /** ส่งงานเข้าคิว · ข้อมูลผ่าน JSON เหมือนกันทั้งสองโหมด (Date กลายเป็น string) · งานที่ล้มครบทุกครั้งถูก log ไม่ throw */
  async enqueue<T>(name: string, data: T, opts: EnqueueOptions = {}): Promise<{ jobId: string }> {
    this.handlerOf(name);
    if (opts.jobId !== undefined && (!opts.jobId || opts.jobId.includes(':'))) throw new Error(`jobId ต้องไม่ว่างและไม่มี ':' (ได้ ${opts.jobId})`);
    const payload = JSON.parse(JSON.stringify(data ?? null)) as T;
    if (this.cfg.mode === 'inline') return this.runInline(name, payload, opts.jobId ?? randomUUID());
    const job = await this.getQueue().add(name, payload, { jobId: opts.jobId, delay: opts.delayMs });
    return { jobId: job.id! };
  }

  /** ตั้งงานตามเวลา (เวลาไทย) · เรียกซ้ำได้ (upsert) · โหมด inline จำไว้เฉย ๆ ไม่รัน */
  async every(name: string, cron: string, data: unknown = {}) {
    this.handlerOf(name);
    if (!CRON.test(cron.trim())) throw new Error(`cron ของงาน ${name} ไม่ถูกต้อง: ${cron}`);
    this.schedules.set(name, cron);
    if (this.cfg.mode === 'inline') return;
    await this.getQueue().upsertJobScheduler(name, { pattern: cron, tz: config.timezone }, { name, data });
  }

  /** เริ่มรับงานจาก Valkey · เรียกจาก src/worker.ts เท่านั้น */
  async startWorker(concurrency = 5) {
    if (this.cfg.mode !== 'bullmq') throw new Error('Worker ต้องใช้ QUEUE_MODE=bullmq และ VALKEY_URL');
    if (this.worker) return;
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: { url: this.cfg.url }, prefix: this.cfg.prefix, concurrency });
    this.worker.on('failed', (job, err) => {
      const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError;
      const msg = `${job?.name} (${job?.id}) ล้มครั้งที่ ${job?.attemptsMade}: ${err.message}`;
      if (final) this.log.error(msg);
      else this.log.warn(msg);
    });
    this.worker.on('error', (err) => this.log.error(`Worker: ${err.message}`));
    await this.worker.waitUntilReady();
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  private handlerOf(name: string) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`ยังไม่ได้ define งาน ${name}`);
    return handler;
  }

  private getQueue() {
    this.queue ??= new Queue(QUEUE_NAME, {
      connection: { url: this.cfg.url },
      prefix: this.cfg.prefix,
      defaultJobOptions: {
        attempts: JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.cfg.backoffMs },
        // เก็บประวัติพอให้ตรวจย้อนหลังได้ แต่ไม่ให้ Valkey โตไม่หยุด
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    return this.queue;
  }

  private async process(job: Job) {
    const handler = this.handlers.get(job.name);
    // Worker เวอร์ชันเก่าที่ยังไม่รู้จักงานใหม่: ไม่ต้อง retry
    if (!handler) throw new UnrecoverableError(`Worker ไม่รู้จักงาน ${job.name}`);
    return handler(job.data, { id: job.id!, name: job.name, attempt: job.attemptsMade + 1 });
  }

  private async runInline(name: string, data: unknown, jobId: string) {
    if (this.running.has(jobId)) return { jobId };
    const handler = this.handlerOf(name);
    this.running.add(jobId);
    try {
      for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
        try {
          await handler(data, { id: jobId, name, attempt });
          return { jobId };
        } catch (err) {
          const final = attempt === JOB_ATTEMPTS || err instanceof UnrecoverableError;
          const msg = `${name} (${jobId}) ล้มครั้งที่ ${attempt}: ${(err as Error).message}`;
          if (final) {
            this.log.error(msg);
            return { jobId };
          }
          this.log.warn(msg);
        }
      }
      return { jobId };
    } finally {
      this.running.delete(jobId);
    }
  }
}
