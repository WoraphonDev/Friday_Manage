import type { Person } from "@/lib/types";

export interface BoardCard {
  key: string;
  type: { name: string; color: string };
  title: string;
  status: { id: string; name: string; category: "todo" | "in_progress" | "done" };
  module: { id: string; name: string; color: string | null } | null;
  phase: { id: string; name: string } | null;
  parentKey: string | null;
  sprintId: string | null;
  priority: "urgent" | "high" | "medium" | "low";
  planStart: string | null;
  planEnd: string | null;
  due: { state: "overdue" | "today" | "soon"; days: number } | null;
  assignees: Person[];
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
  project: { key: string; name: string };
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
