"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ConnectionMode, MiniMap, NodeToolbar, Position, ReactFlow, ReactFlowProvider, getNodesBounds, getViewportForBounds, useEdgesState, useNodesState,
  useReactFlow, useViewport, type Connection, type NodeChange, type OnSelectionChangeParams,
} from "@xyflow/react";
import { ArrowLeft, Download, Lock, Maximize2, Minimize2, Minus, Pencil, Plus, Redo2, Scan, Search as SearchIcon, Trash2, Undo2, X } from "lucide-react";
import { Button, ConfirmDialog, Dialog, ErrorState, Input, LoadingState, NotFound, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import type { Permissions } from "@/lib/types";
import { EdgeContext, EdgeMarkers, edgeTypes, type EdgeData, type FlowEdge } from "./edges";
import { ISSUE_DRAG, Library, SHAPE_DRAG } from "./library";
import { LinkDialog } from "./link-dialog";
import { align, boundsOf, childrenOf, distribute, duplicate, rid, sameSize, toContent, toFlowEdge, toFlowNode, type AlignMode, type FlowNode } from "./ops";
import { CreateTaskDialog, EdgePanel, NodePanel } from "./panel";
import { DiagramContext, SHAPE_DEFS, defaultSize, isContainer, nodeTypes, type PaletteItem } from "./shapes";
import { EdgeBar, MultiBar, NodeBar, TopToolbar, type Tool } from "./toolbars";
import { chipOf, MAX_ISSUES_PER_NODE, type Content, type Diagram, type IssueChip, type IssueOption, type Lock as LockInfo, type NodeData, type SaveResult, type Shape } from "./types";
import styles from "./diagrams.module.css";

type SaveState = "saved" | "pending" | "saving" | "error";

const SAVE_DELAY = 1500;
const HEARTBEAT_MS = 60_000;
// ค่าคงที่ของ React Flow ต้องอ้างอิงเดิมทุก render (ส่ง object ใหม่ = ไลบรารีอัปเดต store ซ้ำ)
const SNAP_GRID: [number, number] = [8, 8];
const FIT_OPTIONS = { padding: 0.2, maxZoom: 1 };
const DELETE_KEYS = ["Backspace", "Delete"];
const PRO_OPTIONS = { hideAttribution: true };
const EDGE_OPTIONS = { type: "diagram" };
const PAN_BUTTONS = [1, 2];
/** มี onNodeClick = React Flow เปิด pointer events ของกล่องในโหมดดู (ป้ายงานใต้กล่องจึงกดได้) */
const NOOP = () => {};
/** คลิปบอร์ดของ Diagram (คัดลอกข้าม Diagram ในโปรเจกต์เดียวกันได้ ใน session นี้) */
let clipboard: { project: string; content: Content } | null = null;

export function DiagramEditorPage(props: { ws: string; projectKey: string; id: string }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ ws, projectKey, id }: { ws: string; projectKey: string; id: string }) {
  const t = useTranslations("diagrams");
  const { me } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params$ = useSearchParams();
  const cache = useQueryClient();
  const toast = useToast();
  const mobile = useIsMobile();
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const api$ = `${base}/diagrams/${encodeURIComponent(id)}`;
  const listHref = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/diagrams`;
  const detailKey = useMemo(() => ["diagrams", ws, projectKey, "detail", id], [ws, projectKey, id]);

  const [editing, setEditing] = useState(false);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [issues, setIssues] = useState<Record<string, IssueChip>>({});
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const [full, setFull] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "takeover">(null);
  const [renaming, setRenaming] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [grid, setGrid] = useState(true);
  const [minimap, setMinimap] = useState(false);
  const [panelTab, setPanelTab] = useState<"format" | "tasks">("format");
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [createFor, setCreateFor] = useState<string | null>(null);
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findAt, setFindAt] = useState(0);
  const [shortcuts, setShortcuts] = useState(false);
  const [iconFocus, setIconFocus] = useState(0);
  const [, setHistoryTick] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api.get<Diagram>(api$, { planDialog: false }),
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
    // คนดูเห็นสิ่งที่คนแก้บันทึกภายในไม่กี่วินาที · ตอนแก้เองไม่ดึงทับ
    refetchInterval: (q) => (editing ? false : q.state.data?.lock && q.state.data.lock.userId !== me.id ? 5000 : 30_000),
  });
  const perms = useQuery({ queryKey: ["permissions", ws, projectKey], queryFn: () => api.get<Permissions>(`${base}/my-permissions`), staleTime: 60_000 });
  const canCreateTask = !!perms.data?.permissions.includes("issue.create");
  const data = detail.data;
  const lockedByOther: LockInfo | null = data?.lock && data.lock.userId !== me.id ? data.lock : null;

  // ค่าล่าสุดสำหรับ callback ที่ไม่ควรสร้างใหม่ทุก render
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const revision = useRef(0);
  const lastSaved = useRef("");
  const loadedRevision = useRef<number | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const resizing = useRef(false);
  const containerDrag = useRef<{ id: string; start: { x: number; y: number }; children: Map<string, { x: number; y: number }> } | null>(null);

  const contentKey = useMemo(() => JSON.stringify(toContent(nodes, edges)), [nodes, edges]);
  const contentKeyRef = useRef(contentKey);
  contentKeyRef.current = contentKey;

  const apply = useCallback(
    (content: Content) => {
      const n = content.nodes.map(toFlowNode);
      const e = content.edges.map(toFlowEdge);
      setNodes(n);
      setEdges(e);
      return JSON.stringify(toContent(n, e));
    },
    [setNodes, setEdges],
  );

  /** ใช้ข้อมูลจาก API (ตอนเปิด / ตอนคนอื่นบันทึก / ตอนได้สิทธิ์แก้) */
  const load = useCallback(
    (d: Diagram) => {
      lastSaved.current = apply(d.content);
      revision.current = d.revision;
      loadedRevision.current = d.revision;
      setIssues(d.issues);
    },
    [apply],
  );

  // ข้อมูลใหม่จากเซิร์ฟเวอร์: ตอนดูอย่างเดียวแสดงทันที · ตอนแก้เองไม่แทนที่งานที่กำลังทำ
  useEffect(() => {
    if (!data || editingRef.current) return;
    if (loadedRevision.current === data.revision && nodesRef.current.length + edgesRef.current.length > 0) {
      setIssues(data.issues);
      return;
    }
    const first = loadedRevision.current === null;
    load(data);
    // เปิดครั้งแรก: จัดให้เห็นทั้งภาพ (prop fitView ทำงานเฉพาะตอนที่มีกล่องตั้งแต่ mount)
    if (first) setTimeout(() => void flow.fitView(FIT_OPTIONS), 50);
  }, [data, load, flow]);

  // เพิ่งสร้าง / เปิดหน้าใหม่ระหว่างที่ตัวเองถือสิทธิ์อยู่ = เข้าโหมดแก้ต่อเลย (มือถือดูได้อย่างเดียว)
  const autoEntered = useRef(false);
  useEffect(() => {
    if (!data || autoEntered.current) return;
    autoEntered.current = true;
    if (data.lock?.userId === me.id && data.permissions.edit && !mobile) setEditing(true);
  }, [data, me.id, mobile]);

  // ---------------------------------------------------------------------------
  // undo / redo (เฉพาะระหว่างแก้ · ไม่มีประวัติเวอร์ชันบนเซิร์ฟเวอร์)
  // ---------------------------------------------------------------------------
  const snapshot = useCallback(() => {
    undoStack.current.push(contentKeyRef.current);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setHistoryTick((x) => x + 1);
  }, []);
  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (prev === undefined) return;
    redoStack.current.push(contentKeyRef.current);
    apply(JSON.parse(prev) as Content);
    setHistoryTick((x) => x + 1);
  }, [apply]);
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (next === undefined) return;
    undoStack.current.push(contentKeyRef.current);
    apply(JSON.parse(next) as Content);
    setHistoryTick((x) => x + 1);
  }, [apply]);

  // ---------------------------------------------------------------------------
  // บันทึกอัตโนมัติ + ถือสิทธิ์แก้
  // ---------------------------------------------------------------------------
  /** ออกจากโหมดแก้: ล้างการเลือก ไม่ให้กรอบม่วงค้างในโหมดดู */
  const clearSelection = useCallback(() => {
    setNodes((cur) => (cur.some((n) => n.selected) ? cur.map((n) => (n.selected ? { ...n, selected: false } : n)) : cur));
    setEdges((cur) => (cur.some((e) => e.selected) ? cur.map((e) => (e.selected ? { ...e, selected: false } : e)) : cur));
  }, [setEdges, setNodes]);

  const lostLock = useCallback(
    (message: string) => {
      clearSelection();
      setEditing(false);
      setSaveState("saved");
      toast({ message, tone: "error" });
      void cache.invalidateQueries({ queryKey: detailKey });
    },
    [cache, detailKey, toast, clearSelection],
  );

  const save = useCallback(async (): Promise<void> => {
    if (!editingRef.current) return;
    if (saving.current) {
      queued.current = true;
      return;
    }
    const key = contentKeyRef.current;
    if (key === lastSaved.current) {
      setSaveState("saved");
      return;
    }
    saving.current = true;
    setSaveState("saving");
    try {
      const r = await api.put<SaveResult>(`${api$}/content`, { revision: revision.current, content: JSON.parse(key) });
      revision.current = r.revision;
      loadedRevision.current = r.revision;
      lastSaved.current = key;
      setIssues((cur) => ({ ...cur, ...r.issues }));
      setSaveState(contentKeyRef.current === key ? "saved" : "pending");
    } catch (e) {
      if (e instanceof ApiError && (e.code === "diagram_locked" || e.code === "diagram_conflict")) lostLock(e.message);
      else {
        setSaveState("error");
        toast({ message: e instanceof Error ? e.message : t("errors.save"), tone: "error" });
      }
    } finally {
      saving.current = false;
      if (queued.current && editingRef.current) {
        queued.current = false;
        void save();
      }
    }
  }, [api$, lostLock, t, toast]);

  useEffect(() => {
    if (!editing || contentKey === lastSaved.current) return;
    setSaveState("pending");
    const h = setTimeout(() => void save(), SAVE_DELAY);
    return () => clearTimeout(h);
  }, [contentKey, editing, save]);

  // ต่ออายุสิทธิ์แก้ระหว่างเปิดหน้าไว้ (ไม่มีการแก้ก็ยังถืออยู่)
  useEffect(() => {
    if (!editing) return;
    const h = setInterval(() => {
      api.post(`${api$}/lock`, {}).catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "diagram_locked") lostLock(e.message);
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(h);
  }, [editing, api$, lostLock]);

  // ออกจากหน้าระหว่างแก้: บันทึกส่วนที่ค้าง แล้วปล่อยสิทธิ์ให้คนอื่น
  useEffect(() => {
    return () => {
      if (!editingRef.current) return;
      const pending = contentKeyRef.current !== lastSaved.current ? api.put(`${api$}/content`, { revision: revision.current, content: JSON.parse(contentKeyRef.current) }).catch(() => undefined) : Promise.resolve();
      void pending.then(() => api.delete(`${api$}/lock`).catch(() => undefined));
    };
  }, [api$]);

  async function startEdit(takeover = false) {
    try {
      const d = await api.post<Diagram>(`${api$}/lock`, { takeover });
      cache.setQueryData(detailKey, d);
      load(d);
      undoStack.current = [];
      redoStack.current = [];
      setSaveState("saved");
      setEditing(true);
      if (takeover) toast({ message: t("lock.tookOver") });
    } catch (e) {
      toast({ message: e instanceof Error ? e.message : t("errors.unknown"), tone: "error" });
      void cache.invalidateQueries({ queryKey: detailKey });
    }
  }

  async function finish() {
    // รอการบันทึกที่กำลังส่งให้จบก่อน แล้วบันทึกส่วนที่เหลือ ไม่ให้ของที่แก้ล่าสุดหายตอนปล่อยสิทธิ์
    while (saving.current) await new Promise((r) => setTimeout(r, 100));
    await save();
    clearSelection();
    setTool("select");
    setEditing(false);
    try {
      await api.delete(`${api$}/lock`);
    } finally {
      await cache.invalidateQueries({ queryKey: detailKey });
      await cache.invalidateQueries({ queryKey: ["diagrams", ws, projectKey, "list"] });
    }
  }

  // ---------------------------------------------------------------------------
  // แก้ภาพ
  // ---------------------------------------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      if (!editingRef.current) {
        // ดูอย่างเดียว: รับเฉพาะการวัดขนาดและการเลือก (ค้นหาในภาพ) ไม่รับการย้าย / ลบ
        onNodesChangeBase(changes.filter((c) => (c.type === "dimensions" && !c.resizing) || c.type === "select"));
        return;
      }
      const resize = changes.find((c) => c.type === "dimensions" && c.resizing !== undefined);
      if (resize && resize.type === "dimensions") {
        if (resize.resizing && !resizing.current) snapshot();
        resizing.current = !!resize.resizing;
      }
      onNodesChangeBase(changes);
    },
    [onNodesChangeBase, snapshot],
  );

  const flowPoint = useCallback((clientX: number, clientY: number) => flow.screenToFlowPosition({ x: clientX, y: clientY }), [flow]);
  const viewCenter = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    return flowPoint((rect?.left ?? 0) + (rect?.width ?? 600) / 2, (rect?.top ?? 0) + (rect?.height ?? 400) / 2);
  }, [flowPoint]);

  const newNode = useCallback(
    (item: PaletteItem, center: { x: number; y: number }, extra: Partial<NodeData> = {}): FlowNode => {
      const type = item.type;
      const size = defaultSize(type);
      const lanes = [t("defaults.lane", { n: 1 }), t("defaults.lane", { n: 2 })];
      const defaults: Partial<NodeData> =
        type === "table" || type === "er-view" ? { columns: [{ name: "id", type: "uuid", key: "pk" }] }
        : type === "er-enum" ? { columns: [{ name: "ACTIVE", type: "", key: null }, { name: "INACTIVE", type: "", key: null }] }
        : type === "uml-class" || type === "uml-interface" ? { body: "- id: uuid\n---\n+ save(): void" }
        : type === "pool" ? { lanes }
        : type === "note" ? { color: "yellow" }
        : {};
      const label = ["table", "er-view", "er-enum", "uml-class", "uml-interface", "lane-h", "lane-v", "pool", "text", "note", "frame"].includes(type) ? t(`defaults.${type}`) : t(`shapes.${type}`);
      return toFlowNode({
        id: `n-${rid()}`,
        type,
        position: { x: Math.round((center.x - size.w / 2) / 8) * 8, y: Math.round((center.y - size.h / 2) / 8) * 8 },
        data: { label, color: "default", issueIds: [], ...defaults, ...item.preset, ...extra },
      });
    },
    [t],
  );

  const insertNodes = useCallback(
    (fresh: FlowNode[], freshEdges: FlowEdge[] = []) => {
      setNodes((cur) => [...cur.map((n) => (n.selected ? { ...n, selected: false } : n)), ...fresh.map((n) => ({ ...n, selected: true }))]);
      setEdges((cur) => [...cur.map((e) => (e.selected ? { ...e, selected: false } : e)), ...freshEdges]);
    },
    [setEdges, setNodes],
  );

  const addItem = useCallback(
    (item: PaletteItem, at?: { x: number; y: number }) => {
      snapshot();
      insertNodes([newNode(item, at ?? viewCenter())]);
    },
    [insertNodes, newNode, snapshot, viewCenter],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      snapshot();
      setEdges((cur) => [...cur, toFlowEdge({ id: `e-${rid()}`, source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle })]);
    },
    [setEdges, snapshot],
  );

  const setLabel = useCallback(
    (nodeId: string, label: string) => {
      snapshot();
      setNodes((cur) => cur.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n)));
    },
    [setNodes, snapshot],
  );

  const patchNode = useCallback(
    (nodeId: string, d: Partial<NodeData>, size?: { width?: number; height?: number }) =>
      setNodes((cur) =>
        cur.map((n) => {
          if (n.id !== nodeId) return n;
          const data = { ...n.data, ...d };
          return { ...n, ...size, data, draggable: data.locked ? false : undefined };
        }),
      ),
    [setNodes],
  );
  const setType = useCallback(
    (nodeId: string, type: Shape) => {
      snapshot();
      setNodes((cur) =>
        cur.map((n) => {
          if (n.id !== nodeId) return n;
          const kind = SHAPE_DEFS[type].kind;
          const data = { ...n.data };
          if ((kind === "table" || kind === "enum") && !data.columns) data.columns = [{ name: "id", type: "uuid", key: "pk" }];
          if (kind === "pool" && !data.lanes) data.lanes = [t("defaults.lane", { n: 1 }), t("defaults.lane", { n: 2 })];
          return { ...n, type, zIndex: isContainer(type) ? -1 : undefined, data };
        }),
      );
    },
    [setNodes, snapshot, t],
  );
  const patchEdge = useCallback(
    (edgeId: string, d: Partial<EdgeData>) =>
      setEdges((cur) =>
        cur.map((e) => {
          if (e.id !== edgeId) return e;
          const data = { ...e.data, ...d };
          return { ...e, data, label: data.text || undefined };
        }),
      ),
    [setEdges],
  );
  const removeSelected = useCallback(() => {
    snapshot();
    const gone = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    setNodes((cur) => cur.filter((n) => !gone.has(n.id)));
    setEdges((cur) => cur.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)));
  }, [setEdges, setNodes, snapshot]);

  const selectedIds = useCallback(() => new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id)), []);
  const doAlign = useCallback((m: AlignMode) => { snapshot(); setNodes((cur) => align(cur, selectedIds(), m)); }, [selectedIds, setNodes, snapshot]);
  const doDistribute = useCallback(() => { snapshot(); setNodes((cur) => distribute(cur, selectedIds())); }, [selectedIds, setNodes, snapshot]);
  const doSameSize = useCallback(() => { snapshot(); setNodes((cur) => sameSize(cur, selectedIds())); }, [selectedIds, setNodes, snapshot]);
  const doDuplicate = useCallback(() => {
    const ids = selectedIds();
    if (!ids.size) return;
    snapshot();
    const copy = duplicate(nodesRef.current, edgesRef.current, ids);
    insertNodes(copy.nodes, copy.edges);
  }, [insertNodes, selectedIds, snapshot]);
  const doGroup = useCallback(() => {
    const ids = selectedIds();
    if (ids.size < 2) return;
    snapshot();
    const b = boundsOf(nodesRef.current, ids);
    const frame = toFlowNode({ id: `n-${rid()}`, type: "group", position: { x: b.x, y: b.y }, width: b.w, height: b.h, data: { label: t("defaults.group"), color: "default", issueIds: [] } });
    setNodes((cur) => [{ ...frame, selected: false }, ...cur]);
  }, [selectedIds, setNodes, snapshot, t]);
  const doArrange = useCallback(
    (dir: "front" | "back") => {
      const ids = selectedIds();
      snapshot();
      const zs = nodesRef.current.map((n) => n.zIndex ?? 0);
      const z = dir === "front" ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs.filter((x) => x > -1)) - 1;
      setNodes((cur) => cur.map((n) => (ids.has(n.id) && !isContainer(n.type as Shape) ? { ...n, zIndex: Math.max(-900, z) } : n)));
    },
    [selectedIds, setNodes, snapshot],
  );
  const copySelection = useCallback(() => {
    const ids = selectedIds();
    if (!ids.size) return;
    const content = toContent(nodesRef.current.filter((n) => ids.has(n.id)), edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)));
    clipboard = { project: base, content };
    toast({ message: t("editor.copied", { n: ids.size }) });
  }, [base, selectedIds, t, toast]);
  const paste = useCallback(() => {
    if (!clipboard?.content.nodes.length) return;
    snapshot();
    const keepIssues = clipboard.project === base;
    const map = new Map<string, string>();
    const fresh = clipboard.content.nodes.map((n) => {
      const nid = `n-${rid()}`;
      map.set(n.id, nid);
      return toFlowNode({ ...n, id: nid, position: { x: n.position.x + 32, y: n.position.y + 32 }, data: { ...n.data, issueIds: keepIssues ? n.data.issueIds : [] } });
    });
    const freshEdges = clipboard.content.edges.map((e) => toFlowEdge({ ...e, id: `e-${rid()}`, source: map.get(e.source)!, target: map.get(e.target)!, bend: e.bend ? { x: e.bend.x + 32, y: e.bend.y + 32 } : undefined }));
    clipboard = { ...clipboard, content: toContent(fresh, freshEdges) };
    insertNodes(fresh, freshEdges);
  }, [base, insertNodes, snapshot]);

  const openIssue = useCallback(
    (key: string) => {
      setOpenTag(null);
      router.push(`${pathname}?${new URLSearchParams({ issue: key })}`, { scroll: false });
    },
    [pathname, router],
  );
  const ctx = useMemo(() => ({ editing, issues, openIssue, setLabel, openTag, setOpenTag, dropTarget }), [editing, issues, openIssue, setLabel, openTag, dropTarget]);
  // React Flow เรียก onSelectionChange ซ้ำเมื่อฟังก์ชันเปลี่ยน จึงต้อง memo และไม่ set state ถ้าการเลือกเหมือนเดิม
  const onSelectionChange = useCallback(({ nodes: n, edges: e }: OnSelectionChangeParams<FlowNode, FlowEdge>) => {
    const next = { nodes: n.map((x) => x.id), edges: e.map((x) => x.id) };
    setSelection((cur) => (cur.nodes.join() === next.nodes.join() && cur.edges.join() === next.edges.join() ? cur : next));
  }, []);
  const beforeDelete = useCallback(async () => {
    snapshot();
    return true;
  }, [snapshot]);
  const focusEdgeLabel = useCallback(() => setTimeout(() => document.getElementById("diagram-edge-label")?.focus(), 0), []);

  // ลากกรอบ / Lane / Pool: กล่องที่อยู่ข้างในย้ายตาม
  const onNodeDragStart = useCallback(
    (_: unknown, node: FlowNode, dragged: FlowNode[]) => {
      snapshot();
      if (dragged.length === 1 && isContainer(node.type as Shape)) {
        const kids = childrenOf(nodesRef.current, node);
        containerDrag.current = { id: node.id, start: { ...node.position }, children: new Map(nodesRef.current.filter((n) => kids.includes(n.id)).map((n) => [n.id, { ...n.position }])) };
      } else containerDrag.current = null;
    },
    [snapshot],
  );
  const onNodeDrag = useCallback(
    (_: unknown, node: FlowNode) => {
      const drag = containerDrag.current;
      if (!drag || drag.id !== node.id || !drag.children.size) return;
      const dx = node.position.x - drag.start.x;
      const dy = node.position.y - drag.start.y;
      setNodes((cur) => cur.map((n) => {
        const from = drag.children.get(n.id);
        return from ? { ...n, position: { x: from.x + dx, y: from.y + dy } } : n;
      }));
    },
    [setNodes],
  );
  const onNodeDragStop = useCallback(() => {
    containerDrag.current = null;
  }, []);

  // เครื่องมือ ข้อความ / โน้ต / กรอบ: คลิกพื้นที่ว่างเพื่อวาง
  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      setOpenTag(null);
      if (!editingRef.current || (tool !== "text" && tool !== "note" && tool !== "frame")) return;
      addItem({ key: tool, type: tool }, flowPoint(e.clientX, e.clientY));
      setTool("select");
    },
    [addItem, flowPoint, tool],
  );

  // เครื่องมือเส้นอิสระ: กดค้างแล้วลาก = จุดต้น → จุดปลาย
  const onPointerDownCapture = useCallback(
    (e: ReactPointerEvent) => {
      if (!editingRef.current || tool !== "line" || e.button !== 0) return;
      if (!(e.target as HTMLElement).closest(".react-flow__pane")) return;
      e.stopPropagation();
      e.preventDefault();
      snapshot();
      const p = flowPoint(e.clientX, e.clientY);
      const point = (): FlowNode => toFlowNode({ id: `p-${rid()}`, type: "point", position: { x: p.x - 6, y: p.y - 6 }, data: { label: "", color: "default", issueIds: [] } });
      const a = point();
      const b = point();
      const edge = toFlowEdge({ id: `e-${rid()}`, source: a.id, target: b.id, sourceHandle: "c", targetHandle: "c", path: "straight", markerEnd: "arrow" });
      setNodes((cur) => [...cur.map((n) => (n.selected ? { ...n, selected: false } : n)), a, b]);
      setEdges((cur) => [...cur, edge]);
      const move = (ev: PointerEvent) => {
        const q = flowPoint(ev.clientX, ev.clientY);
        setNodes((cur) => cur.map((n) => (n.id === b.id ? { ...n, position: { x: q.x - 6, y: q.y - 6 } } : n)));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setTool("select");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [flowPoint, setEdges, setNodes, snapshot, tool],
  );

  // ลากรูปทรง / งานจากคลังซ้าย
  const nodeUnder = (x: number, y: number) => {
    const el = document.elementsFromPoint(x, y).find((d) => d instanceof HTMLElement && d.classList.contains("react-flow__node")) as HTMLElement | undefined;
    const nid = el?.dataset.id;
    return nid && nodesRef.current.find((n) => n.id === nid && n.type !== "point") ? nid : null;
  };
  function onDragOver(e: DragEvent) {
    if (!editing) return;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(SHAPE_DRAG) && !types.includes(ISSUE_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const target = types.includes(ISSUE_DRAG) ? nodeUnder(e.clientX, e.clientY) : null;
    if (target !== dropTarget) setDropTarget(target);
  }
  function onDrop(e: DragEvent) {
    if (!editing) return;
    const shape = e.dataTransfer.getData(SHAPE_DRAG);
    const issue = e.dataTransfer.getData(ISSUE_DRAG);
    const target = dropTarget ?? (issue ? nodeUnder(e.clientX, e.clientY) : null);
    setDropTarget(null);
    if (!shape && !issue) return;
    e.preventDefault();
    const p = flowPoint(e.clientX, e.clientY);
    if (shape) {
      addItem(JSON.parse(shape) as PaletteItem, p);
      return;
    }
    const o = JSON.parse(issue) as IssueOption;
    setIssues((cur) => ({ ...cur, [o.id]: chipOf(o) }));
    if (target) {
      const node = nodesRef.current.find((n) => n.id === target);
      if (!node) return;
      if (node.data.issueIds.includes(o.id)) return toast({ message: t("link.already", { key: o.key }) });
      if (node.data.issueIds.length >= MAX_ISSUES_PER_NODE) return toast({ message: t("link.max", { n: MAX_ISSUES_PER_NODE }), tone: "error" });
      snapshot();
      patchNode(target, { issueIds: [...node.data.issueIds, o.id] });
      toast({ message: t("link.addedTo", { key: o.key, name: node.data.label || t("link.untitled") }) });
      return;
    }
    snapshot();
    insertNodes([newNode({ key: "process", type: "process" }, p, { label: o.title, issueIds: [o.id] })]);
  }

  // ---------------------------------------------------------------------------
  // ค้นหาในภาพ + คีย์ลัด
  // ---------------------------------------------------------------------------
  const findMatches = useMemo(() => {
    const q = findQ.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter((n) => n.data.label.toLowerCase().includes(q) || n.data.issueIds.some((i) => issues[i]?.key.toLowerCase() === q)).map((n) => n.id);
  }, [findQ, nodes, issues]);
  const goToMatch = useCallback(
    (index: number) => {
      const nid = findMatches[index];
      const node = nodesRef.current.find((n) => n.id === nid);
      if (!node) return;
      setFindAt(index);
      setNodes((cur) => cur.map((n) => (n.selected !== (n.id === nid) ? { ...n, selected: n.id === nid } : n)));
      void flow.setCenter(node.position.x + (node.width ?? 0) / 2, node.position.y + (node.height ?? 0) / 2, { zoom: Math.max(flow.getZoom(), 1), duration: 300 });
    },
    [findMatches, flow, setNodes],
  );

  // เปิดจากผลค้นหาที่เจอในกล่อง (?find=คำค้น): เปิดช่องค้นหาในภาพพร้อมคำค้น แล้วพาไปที่กล่องแรกที่ตรง
  const pendingFind = useRef(params$?.get("find") ?? "");
  useEffect(() => {
    const q = pendingFind.current;
    if (!q || !nodes.length) return;
    if (findQ !== q) {
      setFinding(true);
      setFindQ(q);
      return;
    }
    if (!findMatches.length) return;
    pendingFind.current = "";
    setTimeout(() => goToMatch(0), 120);
  }, [nodes.length, findQ, findMatches, goToMatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable=true]");
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "f" && !typing) {
        e.preventDefault();
        setFinding(true);
        return;
      }
      if (typing || !editingRef.current) return;
      if (mod) {
        if (key === "z" && !e.shiftKey) undo();
        else if ((key === "z" && e.shiftKey) || key === "y") redo();
        else if (key === "d") doDuplicate();
        else if (key === "c") copySelection();
        else if (key === "v") paste();
        else if (key === "g") doGroup();
        else if (key === "a") setNodes((cur) => cur.map((n) => ({ ...n, selected: true })));
        else if (key === "b") {
          const picked = nodesRef.current.filter((n) => n.selected);
          if (picked.length) {
            snapshot();
            picked.forEach((n) => patchNode(n.id, { bold: !n.data.bold }));
          }
        } else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      const tools: Record<string, Tool> = { v: "select", h: "pan", t: "text", n: "note", f: "frame", l: "line" };
      if (tools[key]) {
        setTool(tools[key]);
        return;
      }
      if (e.key === "?") {
        setShortcuts(true);
        return;
      }
      if (e.key === "Escape") {
        setTool("select");
        setOpenTag(null);
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const step = arrows[e.key];
      if (step && nodesRef.current.some((n) => n.selected)) {
        e.preventDefault();
        snapshot();
        const d = e.shiftKey ? 10 : 1;
        setNodes((cur) => cur.map((n) => (n.selected && !n.data.locked ? { ...n, position: { x: n.position.x + step[0] * d, y: n.position.y + step[1] * d } } : n)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copySelection, doDuplicate, doGroup, paste, patchNode, redo, setNodes, snapshot, undo]);

  async function exportImage(kind: "png" | "svg") {
    setExportOpen(false);
    const viewport = wrapper.current?.querySelector<HTMLElement>(".react-flow__viewport");
    const all = flow.getNodes();
    if (!viewport || !all.length) return;
    const { toPng, toSvg } = await import("html-to-image");
    const bounds = getNodesBounds(all);
    const width = Math.min(4000, Math.ceil(bounds.width + 120));
    const height = Math.min(4000, Math.ceil(bounds.height + 120));
    const vp = getViewportForBounds(bounds, width, height, 0.1, 2, 0.06);
    const background = getComputedStyle(wrapper.current!).getPropertyValue("--card").trim() || "white";
    try {
      const make = kind === "png" ? toPng : toSvg;
      const url = await make(viewport, {
        backgroundColor: background,
        width,
        height,
        pixelRatio: 2,
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
        // จุดเชื่อมและกรอบปรับขนาดไม่ใช่ส่วนของภาพ
        filter: (el) => !(el instanceof HTMLElement && (el.classList.contains("react-flow__handle") || el.classList.contains("react-flow__resize-control"))),
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(data?.name ?? "diagram").replace(/[\\/:*?"<>|]+/g, "-")}.${kind}`;
      a.click();
    } catch {
      toast({ message: t("errors.export"), tone: "error" });
    }
  }

  // พื้นที่วาดสูงพอดีจอใต้หัวโปรเจกต์ (หัวสูงไม่เท่ากัน เช่น มีแถบทดลองใช้) · เต็มจอใช้ CSS แทน
  const loaded = !!data;
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    if (full) {
      el.style.height = "";
      return;
    }
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      // มือถือมีแถบเมนูล่างทับ ~76 px
      el.style.height = `${Math.max(mobile ? 420 : 560, Math.floor(window.innerHeight - top - (mobile ? 76 : 0)))}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [loaded, full, mobile]);

  // แพ็กเกจ Free: กลับไปหน้ารายการซึ่งแสดงข้อความอัปเกรด
  const planBlocked = detail.error instanceof ApiError && detail.error.code === "plan_feature_unavailable";
  useEffect(() => {
    if (planBlocked) router.replace(listHref);
  }, [planBlocked, router, listHref]);

  const selectedNodes = nodes.filter((n) => selection.nodes.includes(n.id));
  const singleNode = selectedNodes.length === 1 && !selection.edges.length ? selectedNodes[0] : undefined;
  const singleEdge = selection.edges.length === 1 && !selection.nodes.length ? edges.find((e) => e.id === selection.edges[0]) : undefined;
  const multiIds = selectedNodes.filter((n) => n.type !== "point").map((n) => n.id);
  const inDiagram = useMemo(() => new Set(nodes.flatMap((n) => n.data.issueIds)), [nodes]);
  const linkNode = linkFor ? nodes.find((n) => n.id === linkFor) : undefined;
  const createNode = createFor ? nodes.find((n) => n.id === createFor) : undefined;

  const edgeCtx = useMemo(
    () => ({
      editing,
      onBendStart: snapshot,
      setBend: (eid: string, bend: { x: number; y: number } | undefined) => patchEdge(eid, { bend }),
      selectedOnly: singleEdge?.id ?? null,
      toolbar: (edge: { id: string; data?: EdgeData }) => (
        <EdgeBar data={edge.data ?? {}} onPatch={(d) => { snapshot(); patchEdge(edge.id, d); }} onLabel={focusEdgeLabel} onDelete={removeSelected} />
      ),
    }),
    [editing, focusEdgeLabel, patchEdge, removeSelected, singleEdge?.id, snapshot],
  );

  // ---------------------------------------------------------------------------
  if (detail.isLoading) return <LoadingState />;
  if (detail.error instanceof ApiError && (detail.error.status === 404 || detail.error.code === "diagram_not_found")) return <NotFound />;
  if (planBlocked) return <LoadingState />;
  if (detail.error || !data) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;

  const canEdit = data.permissions.edit && !mobile;
  const editedBy = data.updatedBy?.displayName ?? "";
  const panOnDrag = !editing || tool === "pan" ? true : PAN_BUTTONS;

  return (
    <DiagramContext.Provider value={ctx}>
      <EdgeContext.Provider value={edgeCtx}>
        <div ref={page} className={cn(styles.editorPage, full && styles.full)}>
          <div className={styles.editor}>
            <div className={styles.bar}>
              <Link href={listHref} className={styles.iconBtn} aria-label={t("editor.back")} title={t("editor.back")}>
                <ArrowLeft size={16} aria-hidden="true" />
              </Link>
              <h2 className={styles.title}>{data.name}</h2>
              {canEdit && (
                <button type="button" className={styles.iconBtn} aria-label={t("editor.rename")} title={t("editor.rename")} onClick={() => setRenaming(true)}>
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
              {editing ? (
                <span className={cn(styles.saveChip, saveState === "error" && styles.saveError)} role="status">{t(`save.${saveState}`)}</span>
              ) : (
                <span className={styles.sub}>{t("editor.lastEdited", { name: editedBy, date: formatDate(data.updatedAt, me.yearFormat) })}</span>
              )}
              <span className={styles.spacer} />
              {editing && (
                <>
                  <button type="button" className={styles.iconBtn} onClick={undo} disabled={!undoStack.current.length} aria-label={t("editor.undo")} title={t("editor.undo")}><Undo2 size={16} aria-hidden="true" /></button>
                  <button type="button" className={styles.iconBtn} onClick={redo} disabled={!redoStack.current.length} aria-label={t("editor.redo")} title={t("editor.redo")}><Redo2 size={16} aria-hidden="true" /></button>
                </>
              )}
              {!editing && (
                <button type="button" className={styles.iconBtn} onClick={() => setFinding(true)} aria-label={t("tools.search")} title={`${t("tools.search")} (Ctrl F)`}><SearchIcon size={15} aria-hidden="true" /></button>
              )}
              <div className={styles.menuWrap}>
                <Button size="small" onClick={() => setExportOpen((v) => !v)} aria-expanded={exportOpen} disabled={!nodes.length}>
                  <Download size={14} aria-hidden="true" /> {t("editor.export")}
                </Button>
                {exportOpen && (
                  <div className={styles.menu} role="menu">
                    <button type="button" role="menuitem" onClick={() => void exportImage("png")}>{t("editor.exportPng")}</button>
                    <button type="button" role="menuitem" onClick={() => void exportImage("svg")}>{t("editor.exportSvg")}</button>
                  </div>
                )}
              </div>
              <Button size="small" className={styles.desktopOnly} onClick={() => setFull((v) => !v)}>
                {full ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />} {full ? t("editor.exitFull") : t("editor.full")}
              </Button>
              {!editing && data.permissions.delete && !lockedByOther && !mobile && (
                <button type="button" className={styles.iconBtn} onClick={() => setConfirm("delete")} aria-label={t("editor.delete")} title={t("editor.delete")}><Trash2 size={16} aria-hidden="true" /></button>
              )}
              {editing ? (
                <Button size="small" variant="primary" onClick={() => void finish()}>{t("editor.done")}</Button>
              ) : (
                canEdit && (
                  <Button size="small" variant="primary" disabled={!!lockedByOther} onClick={() => void startEdit()}>
                    <Pencil size={14} aria-hidden="true" /> {t("editor.edit")}
                  </Button>
                )
              )}
            </div>

            {!editing && lockedByOther && (
              <div className={styles.banner} role="status">
                <Lock size={16} aria-hidden="true" />
                <span>{t("lock.banner", { name: lockedByOther.user?.displayName ?? "" })}</span>
                <span className={styles.spacer} />
                {data.permissions.takeover && !mobile && <Button size="small" onClick={() => setConfirm("takeover")}>{t("lock.takeover")}</Button>}
              </div>
            )}
            {editing && (
              <TopToolbar
                tool={tool}
                setTool={setTool}
                grid={grid}
                setGrid={setGrid}
                minimap={minimap}
                setMinimap={setMinimap}
                selectedCount={multiIds.length}
                onAlign={doAlign}
                onDistribute={doDistribute}
                onArrange={doArrange}
                onSearch={() => setFinding(true)}
                onShortcuts={() => setShortcuts(true)}
              />
            )}

            <div className={styles.body}>
              {editing && <Library base={base} onAdd={addItem} inDiagram={inDiagram} />}
              <div
                className={cn(styles.canvas, editing ? styles.canvasEdit : styles.canvasView, editing && grid && styles.gridOn, editing && tool !== "select" && tool !== "pan" && styles.placing)}
                ref={wrapper}
                onDragOver={onDragOver}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
                onDrop={onDrop}
                onPointerDownCapture={onPointerDownCapture}
              >
                <EdgeMarkers />
                <ReactFlow<FlowNode, FlowEdge>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={editing ? onEdgesChange : undefined}
                  onConnect={onConnect}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDrag={onNodeDrag}
                  onNodeDragStop={onNodeDragStop}
                  onBeforeDelete={beforeDelete}
                  onSelectionChange={onSelectionChange}
                  onEdgeDoubleClick={focusEdgeLabel}
                  onPaneClick={onPaneClick}
                  onNodeClick={NOOP}
                  connectionMode={ConnectionMode.Loose}
                  nodesDraggable={editing && tool === "select"}
                  nodesConnectable={editing}
                  elementsSelectable={editing}
                  edgesFocusable={editing}
                  nodesFocusable={editing}
                  selectionOnDrag={editing && tool === "select"}
                  panOnDrag={panOnDrag}
                  multiSelectionKeyCode="Shift"
                  deleteKeyCode={editing ? DELETE_KEYS : null}
                  zoomOnDoubleClick={false}
                  snapToGrid={grid}
                  snapGrid={SNAP_GRID}
                  minZoom={0.1}
                  maxZoom={3}
                  fitView
                  fitViewOptions={FIT_OPTIONS}
                  proOptions={PRO_OPTIONS}
                  defaultEdgeOptions={EDGE_OPTIONS}
                >
                  {editing && singleNode && singleNode.type !== "point" && (
                    <NodeToolbar nodeId={singleNode.id} isVisible position={Position.Top} offset={14}>
                      <NodeBar
                        data={singleNode.data}
                        onPatch={(d) => { snapshot(); patchNode(singleNode.id, d); }}
                        onLink={() => { setPanelTab("tasks"); if (!singleNode.data.issueIds.length) setLinkFor(singleNode.id); }}
                        onIcon={() => { setPanelTab("format"); setIconFocus((x) => x + 1); }}
                        onDuplicate={doDuplicate}
                        onDelete={removeSelected}
                      />
                    </NodeToolbar>
                  )}
                  {editing && multiIds.length > 1 && (
                    <NodeToolbar nodeId={multiIds} isVisible position={Position.Top} offset={14}>
                      <MultiBar count={multiIds.length} onAlign={doAlign} onDistribute={doDistribute} onSameSize={doSameSize} onGroup={doGroup} onDuplicate={doDuplicate} onDelete={removeSelected} />
                    </NodeToolbar>
                  )}
                  {minimap && <MiniMap pannable zoomable className={styles.minimap} nodeClassName={styles.minimapNode} />}
                </ReactFlow>
                <ZoomBar />
                {finding && (
                  <div className={styles.find} role="search">
                    <SearchIcon size={14} aria-hidden="true" />
                    <input
                      autoFocus
                      aria-label={t("find.label")}
                      placeholder={t("find.placeholder")}
                      value={findQ}
                      onChange={(e) => { setFindQ(e.target.value); setFindAt(0); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && findMatches.length) goToMatch(e.shiftKey ? (findAt - 1 + findMatches.length) % findMatches.length : (findAt + (nodes.some((n) => n.selected && n.id === findMatches[findAt]) ? 1 : 0)) % findMatches.length);
                        if (e.key === "Escape") setFinding(false);
                      }}
                    />
                    <span className={styles.findCount}>{findQ ? t("find.count", { at: findMatches.length ? findAt + 1 : 0, n: findMatches.length }) : ""}</span>
                    <button type="button" className={styles.iconBtn} aria-label={t("find.close")} onClick={() => { setFinding(false); setFindQ(""); }}><X size={14} /></button>
                  </div>
                )}
                {!nodes.length && <div className={styles.emptyCanvas}>{editing ? t("editor.emptyEdit") : t("editor.emptyView")}</div>}
              </div>
              {editing && ((singleNode && singleNode.type !== "point") || singleEdge) && (
                <aside className={styles.panel} aria-label={t("panel.title")}>
                  {singleNode && singleNode.type !== "point" && (
                    <NodePanel
                      key={singleNode.id}
                      node={singleNode}
                      tab={panelTab}
                      setTab={setPanelTab}
                      issues={issues}
                      iconFocus={iconFocus}
                      onSnapshot={snapshot}
                      onPatch={(d, size) => patchNode(singleNode.id, d, size)}
                      onType={(type) => setType(singleNode.id, type)}
                      onLink={() => setLinkFor(singleNode.id)}
                      onUnlink={(iid) => { snapshot(); patchNode(singleNode.id, { issueIds: singleNode.data.issueIds.filter((x) => x !== iid) }); }}
                      onCreateTask={() => setCreateFor(singleNode.id)}
                      canCreateTask={canCreateTask}
                      onDelete={removeSelected}
                    />
                  )}
                  {singleEdge && <EdgePanel key={singleEdge.id} data={singleEdge.data ?? {}} onSnapshot={snapshot} onPatch={(d) => patchEdge(singleEdge.id, d)} onDelete={removeSelected} />}
                </aside>
              )}
            </div>
          </div>

          <LinkDialog
            open={!!linkNode}
            onOpenChange={(v) => !v && setLinkFor(null)}
            base={base}
            boxLabel={linkNode?.data.label ?? ""}
            linked={linkNode?.data.issueIds ?? []}
            issues={issues}
            onSave={(ids, chips) => {
              if (!linkNode) return;
              snapshot();
              setIssues((cur) => ({ ...cur, ...Object.fromEntries(chips.map((c) => [c.id, c])) }));
              patchNode(linkNode.id, { issueIds: ids });
              setPanelTab("tasks");
            }}
          />
          <CreateTaskDialog
            open={!!createNode}
            onOpenChange={(v) => !v && setCreateFor(null)}
            base={base}
            title={createNode?.data.label ?? ""}
            onCreated={(chip) => {
              if (!createNode) return;
              snapshot();
              setIssues((cur) => ({ ...cur, [chip.id]: chip }));
              patchNode(createNode.id, { issueIds: [...createNode.data.issueIds, chip.id].slice(0, MAX_ISSUES_PER_NODE) });
              toast({ message: t("createTask.done", { key: chip.key }) });
            }}
          />
          <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
          <ConfirmDialog
            open={confirm === "delete"}
            onOpenChange={(open) => !open && setConfirm(null)}
            title={t("deleteDialog.title", { name: data.name })}
            description={t("deleteDialog.description")}
            confirmLabel={t("deleteDialog.confirm")}
            onConfirm={async () => {
              await api.delete(api$);
              await cache.invalidateQueries({ queryKey: ["diagrams", ws, projectKey, "list"] });
              toast({ message: t("deleteDialog.done", { name: data.name }) });
              router.push(listHref);
            }}
          />
          <ConfirmDialog
            open={confirm === "takeover"}
            onOpenChange={(open) => !open && setConfirm(null)}
            destructive={false}
            title={t("lock.takeoverTitle", { name: lockedByOther?.user?.displayName ?? "" })}
            description={t("lock.takeoverDescription", { name: lockedByOther?.user?.displayName ?? "" })}
            confirmLabel={t("lock.takeover")}
            onConfirm={() => startEdit(true)}
          />
          <RenameDialog
            open={renaming}
            onOpenChange={setRenaming}
            diagram={data}
            onSave={async (input) => {
              await api.request(api$, { method: "PATCH", body: input });
              await cache.invalidateQueries({ queryKey: ["diagrams", ws, projectKey] });
            }}
          />
        </div>
      </EdgeContext.Provider>
    </DiagramContext.Provider>
  );
}

function ZoomBar() {
  const t = useTranslations("diagrams.editor");
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className={styles.zoom}>
      <button type="button" onClick={() => void zoomOut()} aria-label={t("zoomOut")} title={t("zoomOut")}><Minus size={14} aria-hidden="true" /></button>
      <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => void zoomIn()} aria-label={t("zoomIn")} title={t("zoomIn")}><Plus size={14} aria-hidden="true" /></button>
      <button type="button" onClick={() => void fitView({ ...FIT_OPTIONS, duration: 300 })} aria-label={t("fit")} title={t("fit")}><Scan size={14} aria-hidden="true" /></button>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["V", "select"], ["H / Space", "pan"], ["T", "text"], ["N", "note"], ["F", "frame"], ["L", "line"],
  ["Ctrl F", "find"], ["Ctrl Z", "undo"], ["Ctrl Shift Z", "redo"], ["Ctrl C / Ctrl V", "copyPaste"], ["Ctrl D", "duplicate"],
  ["Ctrl A", "selectAll"], ["Ctrl G", "group"], ["Ctrl B", "bold"], ["Shift + Click", "addSelect"], ["← ↑ → ↓", "nudge"], ["Delete", "delete"], ["?", "shortcuts"],
];
function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useTranslations("diagrams.shortcuts");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("title")}>
      <table className={styles.shortcutTable}>
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={v}><td><kbd className={styles.kbd}>{k}</kbd></td><td>{t(v)}</td></tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function RenameDialog({ open, onOpenChange, diagram, onSave }: { open: boolean; onOpenChange: (v: boolean) => void; diagram: Diagram; onSave: (input: { name: string; description: string | null }) => Promise<void> }) {
  const t = useTranslations("diagrams");
  const [name, setName] = useState(diagram.name);
  const [description, setDescription] = useState(diagram.description ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) {
      setName(diagram.name);
      setDescription(diagram.description ?? "");
      setError("");
    }
  }, [open, diagram.name, diagram.description]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("rename.title")}>
      <form
        className={styles.form}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return setError(t("create.nameRequired"));
          setPending(true);
          try {
            await onSave({ name: name.trim(), description: description.trim() || null });
            onOpenChange(false);
          } catch (err) {
            setError(err instanceof Error ? err.message : t("errors.unknown"));
          } finally {
            setPending(false);
          }
        }}
      >
        <Input id="diagram-rename" label={t("create.name")} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <Input id="diagram-redescribe" label={t("create.description")} hint={t("create.optional")} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        {error && <p className={styles.err} role="alert">{error}</p>}
        <div className={styles.formActions}>
          <Button onClick={() => onOpenChange(false)}>{t("create.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending}>{t("rename.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
