// ฟังก์ชันล้วนของ editor: แปลง content ↔ React Flow, จัดแนว, ทำซ้ำ, กล่องในกรอบ
import type { Node } from "@xyflow/react";
import type { EdgeData, FlowEdge } from "./edges";
import { defaultSize, isContainer } from "./shapes";
import type { Content, ContentEdge, ContentNode, NodeData, Shape } from "./types";

export type FlowNode = Node<NodeData, Shape>;

export const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "").slice(0, 10);

export function toFlowNode(n: ContentNode): FlowNode {
  const size = defaultSize(n.type);
  const { issueId, ...data } = n.data;
  const issueIds = [...new Set([...(data.issueIds ?? []), ...(issueId ? [issueId] : [])])];
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    width: n.width ?? size.w,
    height: n.height ?? size.h,
    zIndex: isContainer(n.type) ? -1 : n.zIndex,
    draggable: data.locked ? false : undefined,
    data: { ...data, label: data.label ?? "", color: data.color ?? "default", issueIds },
  };
}

export function edgeLabel(e: { label?: string }) {
  return e.label || undefined;
}
export function toFlowEdge(e: ContentEdge): FlowEdge {
  const data: EdgeData = {
    text: e.label,
    cardinality: e.cardinality,
    dashed: e.dashed,
    path: e.path,
    markerStart: e.markerStart,
    markerEnd: e.markerEnd,
    width: e.width,
    color: e.color,
    bend: e.bend,
  };
  return { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null, type: "diagram", label: edgeLabel(e), data };
}

/** เก็บเฉพาะค่าที่ตั้งไว้ (ไม่ใช้ measured) เปิดหน้าแล้วจึงไม่นับว่าแก้ */
export function toContent(nodes: FlowNode[], edges: FlowEdge[]): Content {
  const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
  return {
    nodes: nodes.map((n) => {
      const type = n.type as Shape;
      const size = defaultSize(type);
      const { label, color, issueIds, ...rest } = n.data;
      return {
        id: n.id,
        type,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        width: Math.round(n.width ?? size.w),
        height: Math.round(n.height ?? size.h),
        ...(n.zIndex !== undefined && !isContainer(type) ? { zIndex: n.zIndex } : {}),
        data: { label, color, issueIds: issueIds ?? [], ...clean(rest) },
      };
    }),
    edges: edges.map((e) => {
      const d = e.data ?? {};
      return clean({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        label: d.text,
        cardinality: d.cardinality,
        dashed: d.dashed || undefined,
        path: d.path,
        markerStart: d.markerStart,
        markerEnd: d.markerEnd,
        width: d.width,
        color: d.color,
        bend: d.bend ? { x: Math.round(d.bend.x), y: Math.round(d.bend.y) } : undefined,
      }) as ContentEdge;
    }),
  };
}

const box = (n: FlowNode) => ({ x: n.position.x, y: n.position.y, w: n.width ?? defaultSize(n.type as Shape).w, h: n.height ?? defaultSize(n.type as Shape).h });

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export function align(nodes: FlowNode[], ids: Set<string>, mode: AlignMode): FlowNode[] {
  const picked = nodes.filter((n) => ids.has(n.id)).map(box);
  if (picked.length < 2) return nodes;
  const minX = Math.min(...picked.map((b) => b.x));
  const maxX = Math.max(...picked.map((b) => b.x + b.w));
  const minY = Math.min(...picked.map((b) => b.y));
  const maxY = Math.max(...picked.map((b) => b.y + b.h));
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n;
    const b = box(n);
    const x = mode === "left" ? minX : mode === "right" ? maxX - b.w : mode === "center" ? (minX + maxX) / 2 - b.w / 2 : b.x;
    const y = mode === "top" ? minY : mode === "bottom" ? maxY - b.h : mode === "middle" ? (minY + maxY) / 2 - b.h / 2 : b.y;
    return { ...n, position: { x: Math.round(x), y: Math.round(y) } };
  });
}

/** เว้นระยะเท่ากันตามแนวที่กล่องกระจายกว้างกว่า */
export function distribute(nodes: FlowNode[], ids: Set<string>): FlowNode[] {
  const picked = nodes.filter((n) => ids.has(n.id));
  if (picked.length < 3) return nodes;
  const boxes = picked.map((n) => ({ id: n.id, ...box(n) }));
  const spanX = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
  const spanY = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
  const horizontal = spanX >= spanY;
  const sorted = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const total = sorted.reduce((s, b) => s + (horizontal ? b.w : b.h), 0);
  const first = sorted[0];
  const last = sorted.at(-1)!;
  const gap = ((horizontal ? last.x + last.w - first.x : last.y + last.h - first.y) - total) / (sorted.length - 1);
  const pos = new Map<string, number>();
  let cursor = horizontal ? first.x : first.y;
  for (const b of sorted) {
    pos.set(b.id, cursor);
    cursor += (horizontal ? b.w : b.h) + gap;
  }
  return nodes.map((n) => (pos.has(n.id) ? { ...n, position: horizontal ? { x: Math.round(pos.get(n.id)!), y: n.position.y } : { x: n.position.x, y: Math.round(pos.get(n.id)!) } } : n));
}

/** ขนาดเท่ากับกล่องแรกที่เลือก */
export function sameSize(nodes: FlowNode[], ids: Set<string>): FlowNode[] {
  const first = nodes.find((n) => ids.has(n.id));
  if (!first) return nodes;
  return nodes.map((n) => (ids.has(n.id) ? { ...n, width: first.width, height: first.height } : n));
}

/** ทำซ้ำกล่องที่เลือกพร้อมเส้นระหว่างกัน · เลื่อน 24 px · งานที่ผูกติดไปด้วย (โปรเจกต์เดียวกัน) */
export function duplicate(nodes: FlowNode[], edges: FlowEdge[], ids: Set<string>, offset = 24) {
  const map = new Map<string, string>();
  const newNodes = nodes
    .filter((n) => ids.has(n.id))
    .map((n) => {
      const id = `n-${rid()}`;
      map.set(n.id, id);
      return { ...n, id, selected: true, position: { x: n.position.x + offset, y: n.position.y + offset } };
    });
  const newEdges = edges
    .filter((e) => map.has(e.source) && map.has(e.target))
    .map((e) => ({ ...e, id: `e-${rid()}`, source: map.get(e.source)!, target: map.get(e.target)!, selected: false }));
  return { nodes: newNodes, edges: newEdges };
}

/** กล่องที่อยู่ในกรอบ / Lane ทั้งกล่อง (ใช้ย้ายตามตอนลากกรอบ) */
export function childrenOf(nodes: FlowNode[], container: FlowNode): string[] {
  const c = box(container);
  return nodes
    .filter((n) => n.id !== container.id)
    .filter((n) => {
      const b = box(n);
      return b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
    })
    .map((n) => n.id);
}

/** กรอบล้อมกล่องที่เลือก (จับกลุ่ม) */
export function boundsOf(nodes: FlowNode[], ids: Set<string>, pad = 24) {
  const picked = nodes.filter((n) => ids.has(n.id)).map(box);
  const x = Math.min(...picked.map((b) => b.x)) - pad;
  const y = Math.min(...picked.map((b) => b.y)) - pad - 16;
  const w = Math.max(...picked.map((b) => b.x + b.w)) + pad - x;
  const h = Math.max(...picked.map((b) => b.y + b.h)) + pad - y;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
