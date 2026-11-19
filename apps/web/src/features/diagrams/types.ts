// รูปแบบข้อมูลจาก API แท็บ Diagram (apps/api/src/diagrams) · ตรวจรูปแบบที่ API อีกชั้น
import type { Person } from "@/lib/types";

export const TEMPLATES = ["blank", "flowchart", "er", "architecture", "whiteboard"] as const;
export type Template = (typeof TEMPLATES)[number];

export const SHAPES = [
  "terminator", "process", "decision", "data", "document", "connector",
  "table",
  "service", "database", "queue", "actor", "external", "group",
  "note", "text", "frame",
] as const;
export type Shape = (typeof SHAPES)[number];

export const COLORS = ["default", "purple", "green", "yellow", "pink", "gray"] as const;
export type NodeColor = (typeof COLORS)[number];

export interface Column {
  name: string;
  type: string;
  key: "pk" | "fk" | null;
}
export interface NodeData extends Record<string, unknown> {
  label: string;
  color: NodeColor;
  issueId: string | null;
  columns?: Column[];
}
export interface ContentNode {
  id: string;
  type: Shape;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  zIndex?: number;
  data: NodeData;
}
export interface ContentEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  cardinality?: "1-1" | "1-n" | "n-n";
  dashed?: boolean;
}
export interface Content {
  nodes: ContentNode[];
  edges: ContentEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

/** สีกรอบกล่องที่ผูกงาน · ตรงกับป้ายสถานะ (overdue ชนะสถานะ) */
export type Tone = "todo" | "in_progress" | "review" | "blocked" | "done" | "cancelled" | "overdue" | "deleted";
export interface IssueChip {
  id: string;
  key: string;
  title: string;
  status: string;
  category: string;
  tone: Tone;
  dueDate: string | null;
  deleted: boolean;
}
export interface Lock {
  user: Person | null;
  userId: string;
  until: string;
}
export interface DiagramPermissions {
  edit: boolean;
  takeover: boolean;
  delete: boolean;
  trash?: boolean;
}
export interface Diagram {
  id: string;
  name: string;
  description: string | null;
  template: Template;
  content: Content;
  revision: number;
  createdBy: Person | null;
  updatedBy: Person | null;
  createdAt: string;
  updatedAt: string;
  lock: Lock | null;
  lockMs: number;
  issues: Record<string, IssueChip>;
  permissions: DiagramPermissions;
}
export interface PreviewNode {
  id: string;
  t: Shape;
  x: number;
  y: number;
  w: number;
  h: number;
  s: Tone | null;
}
export interface DiagramSummary {
  id: string;
  name: string;
  description: string | null;
  template: Template;
  issueCount: number;
  createdBy: Person | null;
  updatedBy: Person | null;
  createdAt: string;
  updatedAt: string;
  lock: Lock | null;
  deletedAt: string | null;
  deletedBy: Person | null;
  preview: { nodes: PreviewNode[]; edges: [string, string][] };
}
export interface DiagramList {
  items: DiagramSummary[];
  permissions: DiagramPermissions;
}
export interface SaveResult {
  revision: number;
  updatedAt: string;
  lock: { userId: string; until: string };
  issues: Record<string, IssueChip>;
}
export interface IssueOption {
  id: string;
  key: string;
  title: string;
  status: string;
  category: string;
  tone: Tone;
  assignee: Person | null;
}
