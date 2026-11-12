"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

type Role = "owner" | "admin" | "member" | "guest";
export type StepAction = "new_project" | "import" | "invite" | "table" | "kanban" | "notify_settings" | "profile_hours" | "open_issue";

export interface OnboardingStep {
  key: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  current: number;
  target: number;
  action: { kind: StepAction; path: string } | null;
  detail: Record<string, unknown> | null;
}

/** `GET w/{ws}/onboarding` (A43) · eligible = false: Workspace / สมาชิกเก่าที่ใช้งานจริงแล้ว ไม่แสดงอะไรเลย */
export type OnboardingData =
  | { scope: "workspace" | "member"; version: number; eligible: false }
  | {
      scope: "workspace" | "member";
      version: number;
      eligible: true;
      steps: OnboardingStep[];
      doneCount: number;
      total: number;
      next: string | null;
      completed: boolean;
      hidden: boolean;
      never: boolean;
      completionSeen: boolean;
      invitedBy?: { name: string } | null;
    };
export type Checklist = Extract<OnboardingData, { eligible: true }>;

export const onboardingKey = (ws: string) => ["onboarding", ws] as const;
const base = (ws: string) => `/w/${encodeURIComponent(ws)}/onboarding`;

/**
 * ข้อมูลชุดเดียวที่การ์ดบน Home ปุ่มท้าย Sidebar และเมนูบัญชีใช้ร่วมกัน (เรียก API ครั้งเดียว)
 * Guest ไม่เรียก · ดึงใหม่เมื่อกลับมาที่หน้า (refetch on focus) เพราะขั้นเสร็จจากการทำงานในแท็บอื่น
 * Error เงียบ: คืน undefined ให้ทุกจุดซ่อนตัวเอง
 */
export function useOnboarding(ws: string, role: Role) {
  const q = useQuery({
    queryKey: onboardingKey(ws),
    queryFn: () => api.get<OnboardingData>(base(ws)),
    enabled: role !== "guest",
    retry: false,
    // ข้อมูลเก่าทันที: กลับมาที่หน้า / เปิด Home ใหม่ / สลับแท็บกลับมา = โหลดใหม่ (ขั้นเสร็จจากการทำงานที่หน้าอื่น)
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const data = q.data && q.data.eligible ? q.data : undefined;
  return { data, isPending: q.isPending };
}

/** ซ่อน / แสดง / ไม่ต้องแสดงอีก / เห็นการ์ดครบแล้ว · ปรับ cache ทันทีที่กด แล้วโหลดใหม่ */
export function useOnboardingAction(ws: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (action: "hide" | "show" | "never" | "complete-seen") => api.post<{ hidden: boolean; never: boolean; completionSeen: boolean }>(`${base(ws)}:${action}`),
    onMutate: (action) => {
      const before = cache.getQueryData<OnboardingData>(onboardingKey(ws));
      const patch = action === "hide" ? { hidden: true } : action === "show" ? { hidden: false, never: false } : action === "never" ? { never: true } : { completionSeen: true };
      // การ์ดครบแล้ว (V4) ยังแสดงต่อในหน้านี้จนกว่าจะออก จึงไม่ปรับ cache ตอนบันทึกว่าเห็นแล้ว
      if (before?.eligible && action !== "complete-seen") cache.setQueryData<OnboardingData>(onboardingKey(ws), { ...before, ...patch });
      return { before };
    },
    onError: (_e, _a, ctx) => {
      if (ctx?.before) cache.setQueryData(onboardingKey(ws), ctx.before);
    },
  });
}

/** ปุ่ม "เปิดงาน" ของสมาชิก (V3) · บันทึกขั้นแล้วโหลดรายการใหม่ (ล้มเหลวก็ไม่ขวางการเปิดงาน) */
export function useTaskOpened(ws: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (issueKey: string) => api.post(`${base(ws)}:task-opened`, { issueKey }),
    onSettled: () => void cache.invalidateQueries({ queryKey: onboardingKey(ws) }),
  });
}

/** การ์ดบน Home: ยังไม่ซ่อน และ (ยังไม่ครบ หรือครบแล้วแต่ยังไม่เคยเห็นการ์ดเขียว) */
export const showsCard = (d: Checklist) => !d.hidden && !d.never && (!d.completed || !d.completionSeen);
/** ปุ่มท้าย Sidebar: แสดงจนกว่าจะครบหรือกด "ไม่ต้องแสดงอีก" */
export const showsNavButton = (d: Checklist) => !d.never && !d.completed;
/** เมนูบัญชี: เปิดกลับได้เมื่อซ่อนไว้ (V4) */
export const showsAccountItem = (d: Checklist) => !d.completed && (d.hidden || d.never);
