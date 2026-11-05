// Health ของโปรเจกต์ (หน้า 1, E) · ใช้ร่วมกับ A09, A10
//
// กติกาชั่วคราว (ผู้ใช้ยังไม่ยืนยัน · บันทึกไว้ใน docs/tasks/A08-overview-workload.md):
//   เทียบ % Man-Day ที่ควรเสร็จตามแผน ณ วันนี้ กับ % ที่เสร็จจริง (Done = 100%, ยังไม่ Done = progress_pct)
//   ช้ากว่าแผนไม่เกิน 5 จุด = on track · ไม่เกิน 15 จุด = at risk · เกินกว่านั้น = off track
//   เร็วกว่าแผนถือเป็น on track
import { plannedMdBy, type WorkItem } from './workload.js';
import type { WorkCalendar } from '../projects/calendar.js';

export const HEALTH_THRESHOLDS = { onTrack: 5, atRisk: 15 } as const;
export type HealthLevel = 'on_track' | 'at_risk' | 'off_track';

export function healthLevel(gapPct: number): HealthLevel {
  if (gapPct <= HEALTH_THRESHOLDS.onTrack) return 'on_track';
  if (gapPct <= HEALTH_THRESHOLDS.atRisk) return 'at_risk';
  return 'off_track';
}

export interface HealthItem extends Pick<WorkItem, 'estimateMd' | 'planStart' | 'planEnd'> {
  done: boolean;
  progressPct: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** % ตามแผน vs % จริง จากงานระดับล่างสุดที่มี Man-Day และวันในแผน · ไม่มีงานที่วัดได้ = on track */
export function projectHealth(cal: WorkCalendar, items: HealthItem[], asOf: string) {
  const measured = items.filter((i) => i.estimateMd && i.planStart && i.planEnd);
  const totalMd = measured.reduce((n, i) => n + i.estimateMd!, 0);
  if (!totalMd) return { level: 'on_track' as HealthLevel, plannedPct: 0, actualPct: 0, gapPct: 0, measuredMd: 0 };
  const planned = measured.reduce((n, i) => n + plannedMdBy(cal, i, asOf), 0);
  const actual = measured.reduce((n, i) => n + i.estimateMd! * (i.done ? 1 : (i.progressPct ?? 0) / 100), 0);
  const plannedPct = round1((planned / totalMd) * 100);
  const actualPct = round1((actual / totalMd) * 100);
  const gapPct = round1(plannedPct - actualPct);
  return { level: healthLevel(gapPct), plannedPct, actualPct, gapPct, measuredMd: totalMd };
}
