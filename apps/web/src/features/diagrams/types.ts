// รูปแบบข้อมูลจาก API แท็บ Diagram (apps/api/src/diagrams) · ตรวจรูปแบบที่ API อีกชั้น
import type { Person } from "@/lib/types";

export const TEMPLATES = ["blank", "flowchart", "er", "architecture", "whiteboard"] as const;
export type Template = (typeof TEMPLATES)[number];

export const SHAPES = [
  "terminator", "process", "decision", "data", "document", "multi-document", "subprocess", "manual-input", "manual-operation",
  "preparation", "delay", "merge", "connector", "off-page", "stored-data", "display", "loop-limit", "annotation",
  "lane-h", "lane-v", "pool",
  "uml-class", "uml-interface", "uml-actor", "uml-usecase", "uml-component", "uml-package", "uml-lifeline", "uml-state",
  "actor", "web-app", "mobile-app", "service", "database", "cache", "queue", "storage", "server", "load-balancer", "cdn", "cloud", "external", "firewall", "group",
  "table", "er-view", "er-enum",
  "note", "text", "frame", "rect", "circle", "triangle", "point",
] as const;
export type Shape = (typeof SHAPES)[number];

export const COLORS = ["default", "purple", "green", "yellow", "pink", "gray", "blue", "orange"] as const;
export type NodeColor = (typeof COLORS)[number];
/** ผูกงานได้สูงสุดต่อกล่อง (ผู้ใช้ตัดสิน 2026-11-19) · ตรงกับ API */
export const MAX_ISSUES_PER_NODE = 20;
export const MARKERS = ["none", "arrow", "open", "circle", "diamond", "one", "many", "zero-many", "one-many"] as const;
export type Marker = (typeof MARKERS)[number];

export interface Column {
  name: string;
  type: string;
  /** pkfk = เป็นทั้ง PK และ FK (ตารางเชื่อม) */
  key: "pk" | "fk" | "pkfk" | null;
  /** เช่น 20, 10,2, max · ตรงกับ API (สูงสุด 20 ตัวอักษร) */
  length?: string;
  /** ไม่มีค่า = NOT NULL */
  nullable?: boolean;
  /** เช่น 0, 'ACTIVE', getdate() · ตรงกับ API (สูงสุด 60 ตัวอักษร) */
  defaultValue?: string;
  /** PK เป็น Unique อยู่แล้ว ค่านี้ใช้กับคอลัมน์ที่ไม่ใช่ PK */
  unique?: boolean;
}
export interface NodeData extends Record<string, unknown> {
  label: string;
  color: NodeColor;
  issueIds: string[];
  stroke?: NodeColor;
  strokeStyle?: "solid" | "dashed" | "dotted" | "none";
  fontSize?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  icon?: string | null;
  locked?: boolean;
  columns?: Column[];
  lanes?: string[];
  body?: string;
}
export interface ContentNode {
  id: string;
  type: Shape;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  zIndex?: number;
  data: NodeData & { issueId?: string | null };
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
  path?: "smoothstep" | "straight" | "bezier";
  markerStart?: Marker;
  markerEnd?: Marker;
  width?: number;
  color?: NodeColor;
  bend?: { x: number; y: number };
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
  assignee?: Person | null;
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
  parentKey: string | null;
  level: "task" | "subtask" | "bug";
  module: { id: string; name: string } | null;
  phase: { id: string; name: string } | null;
  status: string;
  category: string;
  tone: Tone;
  dueDate: string | null;
  assignee: Person | null;
}
export interface IssueSearch {
  items: IssueOption[];
  total: number;
  page: number;
  hasMore: boolean;
}
export interface IssueFilters {
  modules: { id: string; name: string }[];
  phases: { id: string; name: string; moduleId: string }[];
  sprints: { id: string; name: string; status: string }[];
  people: Person[];
}
export const chipOf = (o: IssueOption): IssueChip => ({ id: o.id, key: o.key, title: o.title, status: o.status, category: o.category, tone: o.tone, dueDate: o.dueDate, deleted: false, assignee: o.assignee });

/** ชนิดข้อมูลให้เลือกในตาราง ER · รวมชื่อที่ใช้บ่อยของ SQL Server / PostgreSQL / MySQL · ค่าที่ไม่อยู่ในรายการยังเก็บและแสดงได้ */
export const COLUMN_TYPE_GROUPS = [
  { key: "number", types: ["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "float", "real", "money", "serial", "bigserial"] },
  { key: "text", types: ["char", "varchar", "nchar", "nvarchar", "text", "ntext"] },
  { key: "datetime", types: ["date", "time", "datetime", "datetime2", "timestamp", "timestamptz", "interval"] },
  { key: "other", types: ["boolean", "bit", "uuid", "uniqueidentifier", "json", "jsonb", "xml", "binary", "varbinary", "bytea", "blob", "enum"] },
] as const;
/** ชนิดที่รับความยาว/ความละเอียดได้ · ชนิดอื่นปิดช่องความยาว */
export const LENGTH_TYPES = new Set(["decimal", "numeric", "float", "char", "varchar", "nchar", "nvarchar", "time", "datetime2", "timestamp", "timestamptz", "binary", "varbinary", "bit"]);
const KNOWN_TYPES = new Set<string>(COLUMN_TYPE_GROUPS.flatMap((g) => g.types));
/** ชนิดที่พิมพ์เอง (ไม่อยู่ในรายการ) ให้กรอกความยาวได้เสมอ */
export const takesLength = (type: string) => !!type && (LENGTH_TYPES.has(type.toLowerCase()) || !KNOWN_TYPES.has(type.toLowerCase()));
/** ตรงตัวพิมพ์ เพราะ <select> เลือกค่าแบบตรงตัว · "UUID" ที่พิมพ์ไว้เดิมจึงแสดงเป็นช่องพิมพ์เอง */
export const isKnownType = (type: string) => KNOWN_TYPES.has(type);
/** nvarchar + 20 → nvarchar(20) */
export const columnTypeText = (c: Pick<Column, "type" | "length">) => (c.type && c.length ? `${c.type}(${c.length})` : c.type);

export const isPk = (c: Pick<Column, "key">) => c.key === "pk" || c.key === "pkfk";
export const isFk = (c: Pick<Column, "key">) => c.key === "fk" || c.key === "pkfk";
export const keyOf = (pk: boolean, fk: boolean): Column["key"] => (pk && fk ? "pkfk" : pk ? "pk" : fk ? "fk" : null);
