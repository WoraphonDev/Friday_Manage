"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Sprint ของโปรเจกต์ (ผู้ใช้ขอ 2026-11-19): เลือก Sprint ในตาราง / หน้า Task, กรอง และ Export ตาม Sprint
 * โหลดจาก `GET projects/:key/sprints` ชุดเดียว ทุกที่ใช้ cache เดียวกัน
 */
export type SprintStatus = "planning" | "active" | "completed";
export interface Sprint { id: string; number: number; name: string; startDate: string; endDate: string; status: SprintStatus }
export interface SprintList { items: Sprint[]; sprintLengthWeeks: number | null }

export const sprintsKey = (ws: string, projectKey: string) => ["sprints", ws, projectKey] as const;
const path = (ws: string, projectKey: string) => `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}/sprints`;

export function useSprints(ws: string, projectKey: string, enabled = true) {
  return useQuery({ queryKey: sprintsKey(ws, projectKey), queryFn: () => api.get<SprintList>(path(ws, projectKey)), enabled, staleTime: 30_000 });
}

/** หลังสร้าง / แก้ Sprint: รายการ Sprint, Backlog และฟอร์มงานต้องเห็นของใหม่ */
export function useRefreshSprints(ws: string, projectKey: string) {
  const cache = useQueryClient();
  return () => Promise.all([
    cache.invalidateQueries({ queryKey: sprintsKey(ws, projectKey) }),
    cache.invalidateQueries({ queryKey: ["backlog", ws, projectKey] }),
    cache.invalidateQueries({ queryKey: ["form-options", ws, projectKey] }),
    cache.invalidateQueries({ queryKey: ["issue-form-options", ws, projectKey] }),
    cache.invalidateQueries({ queryKey: ["issue-options", ws, projectKey] }),
  ]);
}

export function createSprintSeries(ws: string, projectKey: string, body: { startDate: string; weeks: number; count: number }) {
  return api.post<{ items: Sprint[] }>(`${path(ws, projectKey)}/series`, body);
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** ช่วงวันของ Sprint ที่จะสร้าง · ต้องตรงกับ sprintSeries ใน apps/api/src/sprints/sprint-input.ts */
export function sprintSeries(startDate: string, weeks: number, count: number) {
  const first = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(first) || weeks < 1 || count < 1) return [];
  return Array.from({ length: count }, (_, i) => {
    const start = first + i * weeks * 7 * DAY;
    let end = start + (weeks * 7 - 1) * DAY;
    while (end > start && [0, 6].includes(new Date(end).getUTCDay())) end -= DAY;
    return { startDate: iso(start), endDate: iso(end) };
  });
}

/** วันเริ่มที่แนะนำ: วันจันทร์ถัดจาก Sprint สุดท้าย · ยังไม่มี Sprint = วันจันทร์ของสัปดาห์นี้ */
export function suggestedStart(sprints: Sprint[], today: string) {
  const last = sprints.at(-1);
  let t = Date.parse(`${last ? last.endDate : today}T00:00:00Z`) + (last ? DAY : 0);
  const day = new Date(t).getUTCDay();
  // วันจันทร์ = 1 · ต่อจาก Sprint เดิมเลื่อนไปข้างหน้า · Sprint แรกถอยกลับมาต้นสัปดาห์
  t += last ? ((8 - day) % 7) * DAY : -((day + 6) % 7) * DAY;
  return iso(t);
}

/** Sprint ที่ใส่งานได้ (ปิดแล้วใส่ไม่ได้ ตามกติกาของ API) */
export const openSprint = (s: Sprint) => s.status !== "completed";
