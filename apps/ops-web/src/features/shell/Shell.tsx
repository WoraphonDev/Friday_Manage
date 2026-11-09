"use client";

import { AppShell } from "@/components/shell/AppShell";
import { useMe } from "@/lib/query";

/** โครงหน้าเดิมย้ายไป components/shell/AppShell (O10) · คง export ไว้ให้ import เดิมใช้ได้ */
export const Shell = AppShell;

export function PageHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <div className="muted">{desc}</div>
    </div>
  );
}

/** ใช้ในหน้า: คืนพนักงานที่ล็อกอินอยู่ (Shell โหลดไว้แล้ว) */
export function useStaff() {
  return useMe().data;
}
