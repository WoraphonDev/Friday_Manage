"use client";

/**
 * ทำงานจริงหลัง 10 วินาที เพื่อให้กด "ย้อนกลับ" ได้ (ช่วง 2 · โหมดทำต่อเนื่อง)
 * ปิดแท็บ / ออกจากหน้าก่อนครบเวลา = ส่งทันที (ไม่ทิ้งงานที่ทำไปแล้ว)
 */
export const UNDO_MS = 10_000;
type Job = { timer: ReturnType<typeof setTimeout>; run: () => Promise<unknown> };
const jobs = new Map<string, Job>();

const fire = (key: string) => {
  const job = jobs.get(key);
  if (!job) return Promise.resolve();
  clearTimeout(job.timer);
  jobs.delete(key);
  return job.run();
};

export function defer(key: string, run: () => Promise<unknown>, onError?: (e: unknown) => void, ms = UNDO_MS) {
  // งานเดิมของคีย์เดียวกันส่งไปก่อน
  if (jobs.has(key)) void fire(key).catch(onError);
  const timer = setTimeout(() => void fire(key).catch(onError), ms);
  jobs.set(key, { timer, run });
  return {
    /** ยกเลิกได้ถ้ายังไม่ถึงเวลา · คืน false ถ้าส่งไปแล้ว */
    cancel: () => {
      const job = jobs.get(key);
      if (!job) return false;
      clearTimeout(job.timer);
      jobs.delete(key);
      return true;
    },
  };
}

/** ส่งทุกงานที่รออยู่ทันที */
export const flushAll = () => Promise.allSettled([...jobs.keys()].map(fire));

if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flushAll());
