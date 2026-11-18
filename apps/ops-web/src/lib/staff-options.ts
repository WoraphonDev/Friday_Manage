"use client";

import { useQuery } from "@tanstack/react-query";
import { hasAny } from "@/components/access";
import { api } from "./api";
import { useMe } from "./query";

/**
 * รายชื่อพนักงาน Support เป็นตัวเลือกในตัวกรอง (ผู้ดูแล · ผู้รับผิดชอบ)
 * ops-api เปิด /support/team ให้ Support และ Owner เท่านั้น · บทบาทอื่นได้รายการว่าง (ยังเลือก "ไม่มีผู้ดูแล" ได้)
 * ไม่ส่ง seen=1 เพราะการเปิดตัวกรองไม่ใช่การทำงานในหน้า Support
 */
export function useSupportStaff() {
  const me = useMe().data;
  const allowed = hasAny(me, "support", "owner");
  const q = useQuery({
    queryKey: ["ops", "support-team", "options"],
    queryFn: () => api.get<{ items: { staffId: string; name: string }[] }>("/support/team"),
    enabled: allowed,
    staleTime: 300000,
  });
  return (q.data?.items ?? []).map((m) => ({ value: m.staffId, label: m.name }));
}
