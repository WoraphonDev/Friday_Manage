"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/ui";

// รูปแบบผลค้นหาของ GET w/:ws/search (A22)
export const SEARCH_TYPES = ["task", "sub", "bug", "project", "comment", "file", "person"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
type ProjectRef = { key: string; name: string };
export type IssueHit = { type: "task" | "sub" | "bug"; key: string; title: string; project: ProjectRef; status: { name: string; category: string }; priority: string; planEnd: string | null; matchedIn: "title" | "description"; snippet: string | null };
export type ProjectHit = { type: "project"; key: string; name: string; color: string | null; archived: boolean; goliveDate: string | null };
export type CommentHit = { type: "comment"; issueKey: string; issueTitle: string; project: ProjectRef; commentId: string; snippet: string | null; createdAt: string };
export type FileHit = { type: "file"; id: string; name: string; kind: string; mime: string | null; project: ProjectRef };
export type PersonHit = { type: "person"; id: string; displayName: string; initials: string; avatarUrl: string | null; email: string; jobTitle: string | null };
export type SearchHit = IssueHit | ProjectHit | CommentHit | FileHit | PersonHit;
export interface SearchResult { q: string; total: number; counts: Record<SearchType, number>; items: SearchHit[] }
export interface SavedSearch { id: string; name: string; query: string; filters: Record<string, unknown>; createdAt: string; updatedAt: string }

/** สีและตัวย่อของไอคอนต่อชนิด ตาม Canvas P1 */
export const TYPE_ICON: Record<SearchType | "command", { color: string; ab: string }> = {
  task: { color: "#1D4ED8", ab: "T" },
  sub: { color: "#64748B", ab: "S" },
  bug: { color: "#DC2626", ab: "B" },
  project: { color: "#0F766E", ab: "P" },
  file: { color: "#B45309", ab: "F" },
  comment: { color: "#7C3AED", ab: "C" },
  person: { color: "#BE185D", ab: "@" },
  command: { color: "#334155", ab: ">" },
};

/** กลุ่มผลลัพธ์ตาม Canvas: งาน · โปรเจกต์ · ไฟล์และคอมเมนต์ · คน */
export const GROUPS = [
  { id: "issues", types: ["task", "sub", "bug"] },
  { id: "projects", types: ["project"] },
  { id: "content", types: ["file", "comment"] },
  { id: "people", types: ["person"] },
] as const satisfies readonly { id: string; types: readonly SearchType[] }[];

/** เหมือน KEY_RE ของ API: `#DP-39` หรือ `dp-39` */
export const KEY_RE = /^#?([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;
export const isIssue = (h: SearchHit): h is IssueHit => h.type === "task" || h.type === "sub" || h.type === "bug";

const base = (ws: string) => `/w/${encodeURIComponent(ws)}`;
// project layout เปิด Drawer งานจาก ?issue=KEY
export const issueHref = (ws: string, projectKey: string, key: string) => `${base(ws)}/p/${encodeURIComponent(projectKey)}?issue=${encodeURIComponent(key)}`;
export function hitHref(ws: string, h: SearchHit) {
  switch (h.type) {
    case "project": return `${base(ws)}/p/${encodeURIComponent(h.key)}`;
    case "comment": return issueHref(ws, h.project.key, h.issueKey);
    case "file": return `${base(ws)}/p/${encodeURIComponent(h.project.key)}/files`;
    case "person": return `${base(ws)}/members`;
    default: return issueHref(ws, h.project.key, h.key);
  }
}
export function hitProjectKey(h: SearchHit) {
  return h.type === "project" ? h.key : h.type === "person" ? null : h.project.key;
}

/** คำค้นจริงที่ใช้ไฮไลต์ (ตัด # @ > นำหน้าออก) */
export const bareQuery = (q: string) => q.trim().replace(/^[#@>]\s*/, "");

/** ไฮไลต์ส่วนที่ตรงกับคำค้นด้วย <mark> ตาม Canvas */
export function Highlight({ text, q }: { text: string; q: string }) {
  const needle = bareQuery(q).toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export function TypeIcon({ type, size = 26, label }: { type: SearchType | "command"; size?: number; label?: string }) {
  const { color, ab } = TYPE_ICON[type];
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 6, background: color, color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
      {label ?? ab}
    </span>
  );
}

/** หมวดสถานะของ Workflow → สีของ StatusPill · ชื่อ "Review" ใช้สีเหลืองตาม Canvas */
export function HitStatus({ status }: { status: { name: string; category: string } }) {
  const tone = status.name.trim().toLowerCase() === "review" ? "review" : status.category === "done" ? "done" : status.category === "in_progress" ? "in_progress" : "todo";
  return <StatusPill status={tone} label={status.name} />;
}

export function useDebounced<T>(value: T, ms: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

export const searchKey = (ws: string, params: Record<string, string>) => ["workspace", ws, "search", params] as const;
export const savedSearchesKey = (ws: string) => ["workspace", ws, "saved-searches"] as const;
