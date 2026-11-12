import type { Person } from "@/lib/types";
import type { StatusCategory } from "@/lib/status";

export interface BoardCard {
  key: string;
  type: { name: string; color: string };
  title: string;
  status: { id: string; name: string; category: StatusCategory };
  module: { id: string; name: string; color: string | null } | null;
  phase: { id: string; name: string } | null;
  parentKey: string | null;
  sprintId: string | null;
  priority: "urgent" | "high" | "medium" | "low";
  planStart: string | null;
  planEnd: string | null;
  due: { state: "overdue" | "today" | "soon"; days: number } | null;
  assignees: Person[];
  /** ย้ายการ์ดนี้ได้ไหม · false = งานของคนอื่น ดูได้อย่างเดียว (ไม่ส่งมา = ใช้สิทธิ์ issue.edit อย่างเดียว) */
  canMove?: boolean;
  subtasks: { total: number; done: number } | null;
  comments: number;
  rank: string;
  version: number;
}
export interface BoardColumn {
  id: string;
  name: string;
  category: BoardCard["status"]["category"];
  count: number;
  wip: { limit: number | null; current: number; exceeded: boolean };
  cards: BoardCard[];
}
export interface BoardData {
  project: { key: string; name: string; progressSplit?: boolean };
  board: "standard" | "bug";
  today: string;
  columns: BoardColumn[];
  hiddenDone: number;
  bugStatusColumns: { status: string; column: string }[];
}
export interface MoveBody {
  statusId: string;
  afterKey?: string;
  beforeKey?: string;
  confirm?: boolean;
}
export interface MoveIntent {
  card: BoardCard;
  body: MoveBody;
  targetName: string;
  undo: MoveBody;
}
export interface MoveResult {
  version: number;
  warnings: { code: string; message: string }[];
}
export type Swimlane = "none" | "module" | "assignee" | "priority";

/** ย้ายการ์ดในข้อมูลบนเครื่องทันที (optimistic) ตามตำแหน่งเดียวกับที่ส่งให้ API · หาคอลัมน์ไม่เจอ = null */
export function moveLocal(data: BoardData, key: string, body: MoveBody): BoardData | null {
  const card = data.columns.flatMap((c) => c.cards).find((c) => c.key === key);
  const target = data.columns.find((c) => c.id === body.statusId);
  if (!card || !target) return null;
  // Bug: คอลัมน์ไม่ใช่สถานะจริง (Fixed/Verified อยู่คอลัมน์เดียวกัน) จึงรอสถานะจาก API
  const bug = data.board === "bug" || card.type.name === "Bug";
  const moved = bug ? card : { ...card, status: { id: target.id, name: target.name, category: target.category } };
  const columns = data.columns.map((c) => ({ ...c, cards: c.cards.filter((x) => x.key !== key) }));
  const list = columns.find((c) => c.id === target.id)!.cards;
  const before = body.beforeKey ? list.findIndex((x) => x.key === body.beforeKey) : -1;
  const after = body.afterKey ? list.findIndex((x) => x.key === body.afterKey) : -1;
  list.splice(before >= 0 ? before : after >= 0 ? after + 1 : list.length, 0, moved);
  return { ...data, columns };
}

export function positionIntent(data: BoardData, key: string, columnId: string, beforeKey?: string): MoveIntent | null {
  const source = data.columns.find((c) => c.cards.some((card) => card.key === key));
  const target = data.columns.find((c) => c.id === columnId);
  if (!source || !target || beforeKey === key) return null;
  const originalIndex = source.cards.findIndex((card) => card.key === key);
  const card = source.cards[originalIndex];
  const targetCards = target.cards.filter((c) => c.key !== key);
  const index = beforeKey ? targetCards.findIndex((c) => c.key === beforeKey) : targetCards.length;
  if (index < 0 || (source.id === target.id && index === originalIndex)) return null;
  return {
    card,
    body: { statusId: target.id, afterKey: targetCards[index - 1]?.key, beforeKey: targetCards[index]?.key },
    targetName: target.name,
    // ใช้สถานะจริงเพื่อคืน Bug ที่ Verified โดยไม่ลดกลับเป็น Fixed ตาม mapping ของคอลัมน์
    undo: { statusId: card.status.id, afterKey: source.cards[originalIndex - 1]?.key, beforeKey: source.cards[originalIndex + 1]?.key },
  };
}
