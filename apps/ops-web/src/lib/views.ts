"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** มุมมองที่บันทึก (ช่วง 3) · ตรงกับ ops-api › views/views.module */
export type ViewPage = "workspaces" | "tickets" | "overdue" | "users" | "privacy" | "deliveries" | "invoices";
export interface SavedView {
  id: string;
  page: ViewPage;
  name: string;
  filters: Record<string, string>;
  roles: string[];
  ownerId: string;
  ownerName: string;
  pinned: boolean;
  hidden: boolean;
  position: number;
  isDefault: boolean;
  team: boolean;
  mine: boolean;
  canEdit: boolean;
}
export interface ViewsResponse {
  items: SavedView[];
  canManageTeam: boolean;
  maxPinned: number;
}

export const VIEWS_KEY = ["ops", "views"] as const;
/** หน้าของแต่ละมุมมอง · ค่าเงินสองหน้าอยู่ในแท็บของ /payments */
export const PAGE_PATH: Record<ViewPage, string> = {
  workspaces: "/workspaces",
  tickets: "/support",
  overdue: "/payments?tab=overdue",
  invoices: "/payments?tab=invoices",
  users: "/users",
  privacy: "/privacy",
  deliveries: "/deliveries",
};
/** ลิงก์เปิดมุมมอง: หน้าใส่ตัวกรองจาก ?view= ให้เอง (เปิดจากเมนูซ้ายขณะอยู่หน้าเดิมก็ได้ผล) */
export const viewHref = (v: Pick<SavedView, "id" | "page">) => `${PAGE_PATH[v.page]}${PAGE_PATH[v.page].includes("?") ? "&" : "?"}view=${v.id}`;

export function useViews(page?: ViewPage, enabled = true) {
  return useQuery({
    queryKey: [...VIEWS_KEY, page ?? "all"],
    queryFn: () => api.get<ViewsResponse>(page ? `/views?page=${page}` : "/views"),
    enabled,
    staleTime: 60_000,
  });
}

/** ตัวเลขบนเมนูซ้ายของมุมมองที่ปัก · ถามทุก 2 นาที */
export function useViewCounts(enabled: boolean) {
  return useQuery({
    queryKey: [...VIEWS_KEY, "counts"],
    queryFn: () => api.get<{ items: { id: string; count: number | null }[] }>("/views/counts"),
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

/** ตัวกรองที่ต่างจากค่าเริ่มต้นของหน้า (สิ่งที่บันทึกเป็นมุมมอง) · ไม่รวมเลขหน้า */
export function currentFilters(values: Record<string, string>, defaults: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== "page" && v !== "" && v !== (defaults[k] ?? "")));
}
export const sameFilters = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).filter((k) => a[k] !== "");
  const kb = Object.keys(b).filter((k) => b[k] !== "");
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};
