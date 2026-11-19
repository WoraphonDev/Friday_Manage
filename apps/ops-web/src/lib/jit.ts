"use client";

import { useTranslations } from "next-intl";
import type { OpsRole } from "@/lib/types";

/** ข้อมูลสิทธิ์ชั่วคราวของฉัน (ops-api › /jit/me · O52) · ใช้ทั้งหน้า /jit และแถบนับถอยหลังใน AppShell */
export interface ActiveMine {
  id: string;
  role: OpsRole;
  kind: "break_glass" | "approved";
  startedAt: string;
  endsAt: string;
  ticketRef: string | null;
  approvedBy: string | null;
}
export interface Mine {
  active: ActiveMine[];
  pending: JitPending[];
}
export interface JitPending {
  id: string;
  role: OpsRole;
  minutes: number;
  ticketRef: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

/** ช่วงเวลาที่เหลือแบบสั้น · ใช้ร่วมกับแถบนับถอยหลังใน AppShell */
export function useLeft() {
  const t = useTranslations("jit");
  return (iso: string, now = Date.now()) => {
    const m = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
    return m >= 60 ? (m % 60 ? t("hoursMin", { h: Math.floor(m / 60), m: m % 60 }) : t("hours", { h: m / 60 })) : t("waitMin", { n: m });
  };
}

