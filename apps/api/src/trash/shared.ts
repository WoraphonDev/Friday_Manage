import { rm } from 'node:fs/promises';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { schema, type Tx } from '@friday/db';
import { z } from 'zod';
import { LocalStorage } from '../files/storage.js';

const s = schema;
export const DAY = 86_400_000;
/** งานที่คนเดียวกันลบห่างกันไม่เกิน 2 นาทีนับเป็น "ชุด" เดียว (Z1) */
export const BATCH_WINDOW_MS = 2 * 60_000;
/** คำที่ต้องพิมพ์ก่อนลบถาวร (Z3 · ระดับ 3 ของ P3) */
export const PURGE_CONFIRM = 'ลบถาวร';

export const TRASH_TYPES = ['project', 'issue', 'file'] as const;
export type TrashType = (typeof TRASH_TYPES)[number];

/** trash_days ของ Workspace ปัจจุบัน (RLS กรองให้เหลือแถวเดียว) */
export async function trashDaysOf(tx: Tx) {
  const [ws] = await tx.select({ days: s.workspaceSettings.trashDays }).from(s.workspaceSettings);
  return ws?.days ?? 30;
}

export const purgeAtOf = (deletedAt: Date, days: number) => new Date(deletedAt.getTime() + days * DAY);
/** วันที่เหลือก่อนลบถาวร (ปัดขึ้น · 0 = ลบในรอบถัดไป) */
export const daysLeftOf = (purgeAt: Date, now = Date.now()) => Math.max(0, Math.ceil((purgeAt.getTime() - now) / DAY));

/** "3 ธ.ค. 2569" ตามเวลาไทย · ใช้ในอีเมลและข้อความ Audit */
export const thaiDate = (d: Date) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(d);

export const IdsBody = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict();
export const PurgeBody = z.object({ confirm: z.string().trim() }).strict();
export const PurgeManyBody = z.object({ ids: z.array(z.uuid()).min(1).max(500), confirm: z.string().trim() }).strict();

/**
 * ลบไฟล์ในที่เก็บหลังลบแถวถาวรแล้ว · ไม่มีเมธอดลบใน StorageDriver (files เป็นของ A11) จึงทำที่นี่ตามตัวที่ใช้อยู่
 * ลบไม่สำเร็จไม่ทำให้งานล้ม (แถวหายแล้ว ไฟล์ค้างเป็นแค่พื้นที่ที่ไม่มีใครอ้างถึง)
 */
export async function removeStoredObjects(keys: string[]) {
  if (!keys.length) return;
  if (process.env.S3_BUCKET) {
    const client = new S3Client({ region: process.env.S3_REGION ?? 'ap-southeast-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT });
    for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key })).catch(() => undefined);
    return;
  }
  const local = new LocalStorage();
  for (const k of keys) await rm(local.path(k), { force: true }).catch(() => undefined);
}

/** Key ใหม่ที่ยังว่าง: MKT → MKT2 … MKT9 (ตัดให้ยาวไม่เกิน 10 ตัว) */
export async function suggestKey(base: string, free: (key: string) => Promise<boolean>) {
  for (let n = 2; n < 100; n++) {
    const suffix = String(n);
    const key = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (await free(key)) return key;
  }
  return null;
}
