// คิวงานเบื้องหลัง: โหมด inline รันทุกครั้ง · โหมด BullMQ รันเมื่อตั้ง VALKEY_URL (docker compose up -d valkey หรือ scripts/setup-valkey.sh)
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@friday/db';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_DB } from '../src/db/db.module.js';
import { JOB_ATTEMPTS, type JobContext, Jobs, jobsConfigFromEnv, UnrecoverableError } from '../src/queue/jobs.js';
import { seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let jobs: Jobs;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  jobs = t.app.get(Jobs);
});
afterAll(() => t.close());

describe('โหมด inline (ค่าเริ่มต้นตอน test)', () => {
  it('รันงานทันทีด้วยข้อมูลที่ผ่าน JSON และใช้ฐานข้อมูลได้', async () => {
    const db = t.app.get<Db>(SYSTEM_DB);
    const seen: { data: unknown; ctx: JobContext; projects: number }[] = [];
    jobs.define<{ workspaceId: string; at: Date }>('test.count-projects', async (data, ctx) => {
      const r = await db.execute(sql`SELECT count(*)::int AS n FROM projects WHERE workspace_id = ${data.workspaceId}`);
      seen.push({ data, ctx, projects: (r.rows[0] as { n: number }).n });
    });
    const workspaceId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id as string;
    const input = { workspaceId, at: new Date('2026-12-01T02:00:00Z') };
    const { jobId } = await jobs.enqueue('test.count-projects', input, { jobId: 'count-1' });

    expect(jobs.mode).toBe('inline');
    expect(jobId).toBe('count-1');
    expect(seen).toEqual([{ data: { workspaceId, at: '2026-12-01T02:00:00.000Z' }, ctx: { id: 'count-1', name: 'test.count-projects', attempt: 1 }, projects: 1 }]);
    // handler ได้สำเนา ไม่ใช่ object เดิมของผู้เรียก
    expect(seen[0].data).not.toBe(input);
  });

  it('retry จนสำเร็จ และหยุดที่ 4 ครั้ง (ครั้งแรก + retry 3) โดยไม่ทำให้ผู้เรียกล้ม', async () => {
    const flaky: number[] = [];
    jobs.define('test.flaky', (_data, ctx) => {
      flaky.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error('ชั่วคราว');
    });
    await jobs.enqueue('test.flaky', {});
    expect(flaky).toEqual([1, 2, 3]);

    const broken: number[] = [];
    jobs.define('test.broken', (_data, ctx) => {
      broken.push(ctx.attempt);
      throw new Error('เสียถาวร');
    });
    await expect(jobs.enqueue('test.broken', {})).resolves.toHaveProperty('jobId');
    expect(broken).toHaveLength(JOB_ATTEMPTS);
    expect(JOB_ATTEMPTS).toBe(4);
  });

  it('UnrecoverableError ไม่ retry', async () => {
    let calls = 0;
    jobs.define('test.unrecoverable', () => {
      calls++;
      throw new UnrecoverableError('ข้อมูลผิด ลองใหม่ก็ไม่ผ่าน');
    });
    await jobs.enqueue('test.unrecoverable', {});
    expect(calls).toBe(1);
  });

  it('jobId เดียวกันที่กำลังรันอยู่ไม่ถูกรันซ้อน', async () => {
    let calls = 0;
    jobs.define('test.dedupe', async () => {
      calls++;
      await jobs.enqueue('test.dedupe', {}, { jobId: 'same' });
    });
    await jobs.enqueue('test.dedupe', {}, { jobId: 'same' });
    expect(calls).toBe(1);
  });

  it('ปฏิเสธชื่องานที่ไม่รู้จัก, define ซ้ำ และ jobId ที่ BullMQ ไม่รับ', async () => {
    await expect(jobs.enqueue('test.missing', {})).rejects.toThrow('ยังไม่ได้ define งาน test.missing');
    expect(() => jobs.define('test.flaky', () => undefined)).toThrow('ถูก define ซ้ำ');
    await expect(jobs.enqueue('test.flaky', {}, { jobId: 'a:b' })).rejects.toThrow("ไม่มี ':'");
    await expect(jobs.enqueue('test.flaky', {}, { jobId: '' })).rejects.toThrow('jobId');
  });

  it('every จำงานตามเวลาไว้แต่ไม่รันในโหมด inline และตรวจ cron', async () => {
    let calls = 0;
    jobs.define('test.nightly', () => {
      calls++;
    });
    await jobs.every('test.nightly', '55 23 * * *');
    expect(jobs.scheduled.get('test.nightly')).toBe('55 23 * * *');
    expect(calls).toBe(0);
    await expect(jobs.every('test.nightly', 'ทุกวัน')).rejects.toThrow('cron ของงาน test.nightly ไม่ถูกต้อง');
    await expect(jobs.every('test.unknown', '0 9 * * 1')).rejects.toThrow('ยังไม่ได้ define');
    // ลบงานที่ยังตั้งเวลาอยู่ไม่ได้ · งานเก่าที่ไม่มีแล้วลบได้เสมอ
    await expect(jobs.retire('test.nightly')).rejects.toThrow('ยังตั้งเวลาไว้');
    await jobs.retire('test.gone');
  });
});

describe('เลือกโหมดจาก environment', () => {
  it.each([
    [{}, 'inline'],
    [{ VALKEY_URL: 'redis://localhost:63799' }, 'bullmq'],
    [{ VALKEY_URL: 'redis://localhost:63799', VITEST: 'true' }, 'inline'],
    [{ VALKEY_URL: 'redis://localhost:63799', NODE_ENV: 'test' }, 'inline'],
    [{ VALKEY_URL: 'redis://localhost:63799', QUEUE_MODE: 'inline' }, 'inline'],
    [{ VALKEY_URL: 'redis://localhost:63799', VITEST: 'true', QUEUE_MODE: 'bullmq' }, 'bullmq'],
  ] as const)('%j → %s', (env, mode) => {
    expect(jobsConfigFromEnv(env as NodeJS.ProcessEnv).mode).toBe(mode);
  });

  it('ค่าที่ใช้ไม่ได้ถูกปฏิเสธตั้งแต่เริ่ม', () => {
    expect(() => jobsConfigFromEnv({ QUEUE_MODE: 'bullmq' })).toThrow('ต้องตั้ง VALKEY_URL');
    expect(() => jobsConfigFromEnv({ QUEUE_MODE: 'kafka' })).toThrow('QUEUE_MODE ต้องเป็น inline หรือ bullmq');
  });
});

const valkeyUrl = process.env.VALKEY_URL;

describe.runIf(Boolean(valkeyUrl))('โหมด BullMQ กับ Valkey จริง', () => {
  const prefix = `friday-test-${randomUUID()}`;
  const cfg = { mode: 'bullmq' as const, url: valkeyUrl, prefix, backoffMs: 20 };
  let worker: Jobs;
  let producer: Jobs;
  let inspect: Queue;
  const waiters = new Map<string, (ctx: JobContext & { data: unknown }) => void>();
  const done = (key: string) =>
    new Promise<JobContext & { data: unknown }>((resolve, reject) => {
      waiters.set(key, resolve);
      setTimeout(() => reject(new Error(`รอ ${key} นานเกินไป`)), 10_000);
    });

  beforeAll(async () => {
    // ผู้ส่ง (เหมือน API) กับผู้รัน (เหมือน src/worker.ts) เป็นคนละ instance ที่ define งานชุดเดียวกัน
    worker = new Jobs(cfg);
    producer = new Jobs(cfg);
    const attempts: number[] = [];
    for (const j of [worker, producer]) {
      j.define<{ key: string }>('test.echo', (data, ctx) => waiters.get(data.key)?.({ ...ctx, data }));
      j.define<{ key: string }>('test.flaky', (data, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt < 3) throw new Error('ชั่วคราว');
        waiters.get(data.key)?.({ ...ctx, data: attempts });
      });
      j.define('test.nightly', () => undefined);
    }
    await worker.startWorker(2);
    inspect = new Queue('jobs', { connection: { url: valkeyUrl }, prefix });
  });

  afterAll(async () => {
    await worker?.onModuleDestroy();
    await producer?.onModuleDestroy();
    await inspect?.obliterate({ force: true });
    await inspect?.close();
  });

  it('ส่งงานจาก API แล้ว Worker อีก instance รันด้วยข้อมูลผ่าน JSON', async () => {
    const wait = done('echo');
    const { jobId } = await producer.enqueue('test.echo', { key: 'echo', at: new Date('2026-12-01T02:00:00Z') });
    expect(await wait).toEqual({ id: jobId, name: 'test.echo', attempt: 1, data: { key: 'echo', at: '2026-12-01T02:00:00.000Z' } });
  });

  it('retry แบบ backoff จนสำเร็จ และตั้ง attempts = 4 เป็นค่าเริ่มต้น', async () => {
    const wait = done('flaky');
    const { jobId } = await producer.enqueue('test.flaky', { key: 'flaky' });
    expect((await wait).data).toEqual([1, 2, 3]);
    const job = await inspect.getJob(jobId);
    expect(job?.opts).toMatchObject({ attempts: JOB_ATTEMPTS, backoff: { type: 'exponential', delay: 20 } });
  });

  it('jobId ซ้ำไม่เพิ่มงานใหม่', async () => {
    const idle = new Jobs({ ...cfg, prefix: `${prefix}-idle` });
    idle.define('test.echo', () => undefined);
    const idleQueue = new Queue('jobs', { connection: { url: valkeyUrl }, prefix: `${prefix}-idle` });
    try {
      const a = await idle.enqueue('test.echo', { n: 1 }, { jobId: 'daily-digest-2026-12-01' });
      const b = await idle.enqueue('test.echo', { n: 2 }, { jobId: 'daily-digest-2026-12-01' });
      expect(b.jobId).toBe(a.jobId);
      expect((await idleQueue.getJob(a.jobId))?.data).toEqual({ n: 1 });
      expect(await idleQueue.getJobCountByTypes('waiting')).toBe(1);
    } finally {
      await idle.onModuleDestroy();
      await idleQueue.obliterate({ force: true });
      await idleQueue.close();
    }
  });

  it('every ตั้ง scheduler ตามเวลาไทย และเรียกซ้ำได้โดยไม่สร้างซ้ำ', async () => {
    await producer.every('test.nightly', '55 23 * * *');
    await producer.every('test.nightly', '55 23 * * *');
    const schedulers = await inspect.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: 'test.nightly', pattern: '55 23 * * *', tz: 'Asia/Bangkok' });
  });

  it('retire ลบ scheduler ของงานที่เลิกใช้ (เช่นหลังรวมแจ้งเตือนเป็นสรุปประจำวัน)', async () => {
    const old = new Jobs(cfg);
    old.define('test.retired', () => undefined);
    await old.every('test.retired', '0 8 * * *');
    expect((await inspect.getJobSchedulers()).map((x) => x.key)).toContain('test.retired');
    // เวอร์ชันใหม่ไม่มีงานนี้แล้ว
    await producer.retire('test.retired');
    expect((await inspect.getJobSchedulers()).map((x) => x.key)).not.toContain('test.retired');
    await old.onModuleDestroy();
  });
});
