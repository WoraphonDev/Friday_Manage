"use client";

import "@xyflow/react/dist/base.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ConnectionMode,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { ArrowLeft, Download, Lock, Maximize2, Minimize2, Minus, Pencil, Plus, Redo2, Scan, Trash2, Undo2, X } from "lucide-react";
import { Button, ConfirmDialog, Dialog, ErrorState, Input, LoadingState, NotFound, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import { DiagramContext, SHAPE_GROUPS, ShapeIcon, defaultSize, isContainer, nodeTypes } from "./shapes";
import { COLORS, SHAPES, type Column, type Content, type ContentEdge, type ContentNode, type Diagram, type IssueChip, type IssueOption, type Lock as LockInfo, type NodeColor, type NodeData, type SaveResult, type Shape } from "./types";
import styles from "./diagrams.module.css";

type FlowNode = Node<NodeData, Shape>;
type EdgeData = { cardinality?: ContentEdge["cardinality"]; dashed?: boolean; text?: string };
type FlowEdge = Edge<EdgeData>;
type SaveState = "saved" | "pending" | "saving" | "error";

const DRAG_TYPE = "application/x-friday-shape";
const SAVE_DELAY = 1500;
const HEARTBEAT_MS = 60_000;
const CARD_TEXT: Record<NonNullable<ContentEdge["cardinality"]>, string> = { "1-1": "1 : 1", "1-n": "1 : N", "n-n": "N : N" };
const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, "").slice(0, 10);

// ---------------------------------------------------------------------------
// แปลงระหว่าง content ที่ API เก็บ กับ node / edge ของ React Flow
// ---------------------------------------------------------------------------
function toFlowNode(n: ContentNode): FlowNode {
  const size = defaultSize(n.type);
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    width: n.width ?? size.w,
    height: n.height ?? size.h,
    zIndex: isContainer(n.type) ? -1 : n.zIndex,
    data: { label: n.data.label ?? "", color: n.data.color ?? "default", issueId: n.data.issueId ?? null, ...(n.data.columns ? { columns: n.data.columns } : {}) },
  };
}
function edgeText(label?: string, cardinality?: ContentEdge["cardinality"]) {
  return [label, cardinality ? CARD_TEXT[cardinality] : ""].filter(Boolean).join(" · ") || undefined;
}
function toFlowEdge(e: ContentEdge): FlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    type: "smoothstep",
    label: edgeText(e.label, e.cardinality),
    markerEnd: e.cardinality ? undefined : { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: e.dashed ? { strokeDasharray: "6 4" } : undefined,
    data: { cardinality: e.cardinality, dashed: e.dashed, text: e.label },
  };
}
function toContent(nodes: FlowNode[], edges: FlowEdge[]): Content {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as Shape,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      // ใช้ขนาดที่ตั้งไว้เท่านั้น (ไม่ใช้ measured) เปิดหน้าแล้วจึงไม่นับว่าแก้
      width: Math.round(n.width ?? defaultSize(n.type as Shape).w),
      height: Math.round(n.height ?? defaultSize(n.type as Shape).h),
      ...(n.zIndex !== undefined && !isContainer(n.type as Shape) ? { zIndex: n.zIndex } : {}),
      data: { label: n.data.label, color: n.data.color, issueId: n.data.issueId, ...(n.data.columns ? { columns: n.data.columns } : {}) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      ...(e.data?.text ? { label: e.data.text } : {}),
      ...(e.data?.cardinality ? { cardinality: e.data.cardinality } : {}),
      ...(e.data?.dashed ? { dashed: true } : {}),
    })),
  };
}

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
  const [, setHistoryTick] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api.get<Diagram>(api$, { planDialog: false }),
    retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
    // คนดูเห็นสิ่งที่คนแก้บันทึกภายในไม่กี่วินาที · ตอนแก้เองไม่ดึงทับ
    refetchInterval: (q) => (editing ? false : q.state.data?.lock && q.state.data.lock.userId !== me.id ? 5000 : 30_000),
  });
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
    if (first) setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }), 50);
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

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable=true]"))) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, undo, redo]);

  // ---------------------------------------------------------------------------
  // บันทึกอัตโนมัติ + ถือสิทธิ์แก้
  // ---------------------------------------------------------------------------
  const lostLock = useCallback(
    (message: string) => {
      setEditing(false);
      setSaveState("saved");
      toast({ message, tone: "error" });
      void cache.invalidateQueries({ queryKey: detailKey });
    },
    [cache, detailKey, toast],
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
      if (e instanceof ApiError && e.code === "diagram_locked") lostLock(e.message);
      else if (e instanceof ApiError && e.code === "diagram_conflict") lostLock(e.message);
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
        // ดูอย่างเดียว: รับเฉพาะการวัดขนาด ไม่รับการย้าย / ลบ
        onNodesChangeBase(changes.filter((c) => c.type === "dimensions" && !c.resizing));
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

  const addNode = useCallback(
    (type: Shape, at?: { x: number; y: number }) => {
      snapshot();
      const size = defaultSize(type);
      let position = at;
      if (!position) {
        const rect = wrapper.current?.getBoundingClientRect();
        const center = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 600) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 400) / 2 });
        position = { x: center.x - size.w / 2, y: center.y - size.h / 2 };
      }
      const label = type === "text" ? t("defaults.text") : type === "table" ? "table_name" : t(`shapes.${type}`);
      const node: FlowNode = toFlowNode({
        id: `n-${rid()}`,
        type,
        position: { x: Math.round(position.x / 8) * 8, y: Math.round(position.y / 8) * 8 },
        data: {
          label,
          color: type === "note" ? "yellow" : "default",
          issueId: null,
          ...(type === "table" ? { columns: [{ name: "id", type: "uuid", key: "pk" as const }] } : {}),
        },
      });
      setNodes((cur) => [...cur.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
      setEdges((cur) => cur.map((e) => ({ ...e, selected: false })));
    },
    [flow, setEdges, setNodes, snapshot, t],
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
    (nodeId: string, patch: (n: FlowNode) => FlowNode) => setNodes((cur) => cur.map((n) => (n.id === nodeId ? patch(n) : n))),
    [setNodes],
  );
  const patchEdge = useCallback(
    (edgeId: string, d: Partial<EdgeData>) =>
      setEdges((cur) =>
        cur.map((e) => {
          if (e.id !== edgeId) return e;
          const next = { ...e.data, ...d };
          const fresh = toFlowEdge({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, label: next.text, cardinality: next.cardinality, dashed: next.dashed });
          return { ...fresh, selected: e.selected };
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

  const openIssue = useCallback(
    (key: string) => {
      const params = new URLSearchParams({ issue: key });
      router.push(`${pathname}?${params}`, { scroll: false });
    },
    [pathname, router],
  );
  const ctx = useMemo(() => ({ editing, issues, openIssue, setLabel }), [editing, issues, openIssue, setLabel]);

  async function exportImage(kind: "png" | "svg") {
    setExportOpen(false);
    const viewport = wrapper.current?.querySelector<HTMLElement>(".react-flow__viewport");
    const all = flow.getNodes();
    if (!viewport || !all.length) return;
    const { toPng, toSvg } = await import("html-to-image");
    const bounds = getNodesBounds(all);
    const width = Math.min(4000, Math.ceil(bounds.width + 96));
    const height = Math.min(4000, Math.ceil(bounds.height + 96));
    const vp = getViewportForBounds(bounds, width, height, 0.1, 2, 0.05);
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

  // แพ็กเกจ Free: กลับไปหน้ารายการซึ่งแสดงข้อความอัปเกรด
  const planBlocked = detail.error instanceof ApiError && detail.error.code === "plan_feature_unavailable";
  useEffect(() => {
    if (planBlocked) router.replace(listHref);
  }, [planBlocked, router, listHref]);

  // ---------------------------------------------------------------------------
  if (detail.isLoading) return <LoadingState />;
  if (detail.error instanceof ApiError && (detail.error.status === 404 || detail.error.code === "diagram_not_found")) return <NotFound />;
  if (planBlocked) return <LoadingState />;
  if (detail.error || !data) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;

  const selectedNode = selection.nodes.length === 1 && !selection.edges.length ? nodes.find((n) => n.id === selection.nodes[0]) : undefined;
  const selectedEdge = selection.edges.length === 1 && !selection.nodes.length ? edges.find((e) => e.id === selection.edges[0]) : undefined;
  const canEdit = data.permissions.edit && !mobile;
  const editedBy = data.updatedBy?.displayName ?? "";

  return (
    <DiagramContext.Provider value={ctx}>
      <div className={cn(styles.editorPage, full && styles.full)}>
        <div className={styles.editor}>
          <div className={styles.bar}>
            <Link href={listHref} className={styles.iconBtn} aria-label={t("editor.back")} title={t("editor.back")}>
              <ArrowLeft size={16} aria-hidden="true" />
            </Link>
            <h1 className={styles.title}>{data.name}</h1>
            {data.permissions.edit && (
              <button type="button" className={styles.iconBtn} aria-label={t("editor.rename")} title={t("editor.rename")} onClick={() => setRenaming(true)}>
                <Pencil size={14} aria-hidden="true" />
              </button>
            )}
            {editing ? (
              <span className={cn(styles.saveChip, saveState === "error" && styles.saveError)} role="status">
                {t(`save.${saveState}`)}
              </span>
            ) : (
              <span className={styles.sub}>{t("editor.lastEdited", { name: editedBy, date: formatDate(data.updatedAt, me.yearFormat) })}</span>
            )}
            <span className={styles.spacer} />
            {editing && (
              <>
                <button type="button" className={styles.iconBtn} onClick={undo} disabled={!undoStack.current.length} aria-label={t("editor.undo")} title={t("editor.undo")}>
                  <Undo2 size={16} aria-hidden="true" />
                </button>
                <button type="button" className={styles.iconBtn} onClick={redo} disabled={!redoStack.current.length} aria-label={t("editor.redo")} title={t("editor.redo")}>
                  <Redo2 size={16} aria-hidden="true" />
                </button>
              </>
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
            {!editing && data.permissions.delete && !lockedByOther && (
              <button type="button" className={styles.iconBtn} onClick={() => setConfirm("delete")} aria-label={t("editor.delete")} title={t("editor.delete")}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
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
              {data.permissions.takeover && !mobile && (
                <Button size="small" onClick={() => setConfirm("takeover")}>{t("lock.takeover")}</Button>
              )}
            </div>
          )}

          <div className={styles.body}>
            {editing && <Palette onAdd={addNode} />}
            <div
              className={cn(styles.canvas, editing ? styles.canvasEdit : styles.canvasView)}
              ref={wrapper}
              onDragOver={(e) => {
                if (!editing) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(e) => {
                if (!editing) return;
                const type = e.dataTransfer.getData(DRAG_TYPE) as Shape;
                if (!SHAPES.includes(type)) return;
                e.preventDefault();
                const size = defaultSize(type);
                const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
                addNode(type, { x: p.x - size.w / 2, y: p.y - size.h / 2 });
              }}
            >
              <ReactFlow<FlowNode, FlowEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={editing ? onEdgesChange : undefined}
                onConnect={onConnect}
                onNodeDragStart={() => snapshot()}
                onBeforeDelete={async () => {
                  snapshot();
                  return true;
                }}
                onSelectionChange={({ nodes: n, edges: e }: OnSelectionChangeParams<FlowNode, FlowEdge>) => setSelection({ nodes: n.map((x) => x.id), edges: e.map((x) => x.id) })}
                onEdgeDoubleClick={() => document.getElementById("diagram-edge-label")?.focus()}
                connectionMode={ConnectionMode.Loose}
                nodesDraggable={editing}
                nodesConnectable={editing}
                elementsSelectable={editing}
                edgesFocusable={editing}
                nodesFocusable={editing}
                deleteKeyCode={editing ? ["Backspace", "Delete"] : null}
                zoomOnDoubleClick={false}
                snapToGrid
                snapGrid={[8, 8]}
                minZoom={0.1}
                maxZoom={3}
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "smoothstep" }}
              />
              <ZoomBar />
              {!nodes.length && (
                <div className={styles.emptyCanvas}>{editing ? t("editor.emptyEdit") : t("editor.emptyView")}</div>
              )}
            </div>
            {editing && (selectedNode || selectedEdge) && (
              <aside className={styles.panel} aria-label={t("panel.title")}>
                {selectedNode && (
                  <NodePanel
                    key={selectedNode.id}
                    node={selectedNode}
                    issues={issues}
                    base={base}
                    onSnapshot={snapshot}
                    onPatch={(patch) => patchNode(selectedNode.id, patch)}
                    onIssue={(chip) => setIssues((cur) => ({ ...cur, [chip.id]: chip }))}
                    onDelete={removeSelected}
                  />
                )}
                {selectedEdge && (
                  <EdgePanel
                    key={selectedEdge.id}
                    edge={selectedEdge}
                    er={[selectedEdge.source, selectedEdge.target].some((x) => nodes.find((n) => n.id === x)?.type === "table")}
                    onSnapshot={snapshot}
                    onPatch={(d) => patchEdge(selectedEdge.id, d)}
                    onDelete={removeSelected}
                  />
                )}
              </aside>
            )}
          </div>
        </div>

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
      <button type="button" onClick={() => void fitView({ padding: 0.2, maxZoom: 1, duration: 300 })} aria-label={t("fit")} title={t("fit")}><Scan size={14} aria-hidden="true" /></button>
    </div>
  );
}

function Palette({ onAdd }: { onAdd: (type: Shape) => void }) {
  const t = useTranslations("diagrams");
  const [q, setQ] = useState("");
  const match = (s: Shape) => !q.trim() || t(`shapes.${s}`).toLowerCase().includes(q.trim().toLowerCase());
  return (
    <div className={styles.palette}>
      <input className={styles.paletteSearch} placeholder={t("palette.search")} aria-label={t("palette.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <p className={styles.paletteHint}>{t("palette.hint")}</p>
      {SHAPE_GROUPS.map((g) => {
        const shapes = g.shapes.filter(match);
        if (!shapes.length) return null;
        return (
          <div key={g.key} className={styles.paletteGroup}>
            <div className={styles.paletteTitle}>{t(`templates.${g.key}`)}</div>
            <div className={styles.paletteItems}>
              {shapes.map((s) => (
                <button
                  key={s}
                  type="button"
                  draggable
                  className={styles.paletteItem}
                  title={t("palette.add", { shape: t(`shapes.${s}`) })}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, s);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => onAdd(s)}
                >
                  <ShapeIcon type={s} />
                  <span>{t(`shapes.${s}`)}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NodePanel({
  node,
  issues,
  base,
  onSnapshot,
  onPatch,
  onIssue,
  onDelete,
}: {
  node: FlowNode;
  issues: Record<string, IssueChip>;
  base: string;
  onSnapshot: () => void;
  onPatch: (patch: (n: FlowNode) => FlowNode) => void;
  onIssue: (chip: IssueChip) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("diagrams");
  const type = node.type as Shape;
  const typed = useRef(false);
  const setData = (d: Partial<NodeData>) => onPatch((n) => ({ ...n, data: { ...n.data, ...d } }));
  const onceSnapshot = () => {
    if (!typed.current) onSnapshot();
    typed.current = true;
  };
  const columns = node.data.columns ?? [];
  const setColumns = (next: Column[]) => setData({ columns: next });
  return (
    <div className={styles.panelBody}>
      <h2 className={styles.panelTitle}>{t("panel.title")}</h2>
      <label className={styles.field}>
        <span>{type === "table" ? t("panel.tableName") : t("panel.text")}</span>
        <textarea
          id="diagram-node-label"
          className={styles.textarea}
          rows={type === "table" ? 1 : 3}
          maxLength={500}
          value={node.data.label}
          onFocus={() => (typed.current = false)}
          onChange={(e) => {
            onceSnapshot();
            setData({ label: e.target.value });
          }}
        />
      </label>
      <Select
        size="small"
        label={t("panel.shape")}
        value={type}
        onChange={(e) => {
          onSnapshot();
          const next = e.target.value as Shape;
          onPatch((n) => ({ ...n, type: next, zIndex: isContainer(next) ? -1 : undefined, data: next === "table" && !n.data.columns ? { ...n.data, columns: [{ name: "id", type: "uuid", key: "pk" }] } : n.data }));
        }}
      >
        {SHAPE_GROUPS.map((g) => (
          <optgroup key={g.key} label={t(`templates.${g.key}`)}>
            {g.shapes.map((s) => (
              <option key={s} value={s}>{t(`shapes.${s}`)}</option>
            ))}
          </optgroup>
        ))}
      </Select>
      <div className={styles.field}>
        <span>{t("panel.color")}</span>
        <div className={styles.swatches} role="radiogroup" aria-label={t("panel.color")}>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={node.data.color === c}
              aria-label={t(`colors.${c}`)}
              title={t(`colors.${c}`)}
              className={cn(styles.swatch, styles[`color_${c}`], node.data.color === c && styles.swatchOn)}
              onClick={() => {
                onSnapshot();
                setData({ color: c as NodeColor });
              }}
            />
          ))}
        </div>
        {node.data.issueId && <p className={styles.hint}>{t("panel.colorLinked")}</p>}
      </div>
      {type === "table" && (
        <div className={styles.field}>
          <span>{t("panel.columns")}</span>
          <div className={styles.columns}>
            {columns.map((c, i) => (
              <div key={i} className={styles.columnRow}>
                <input
                  className={styles.mini}
                  aria-label={t("panel.columnName")}
                  placeholder={t("panel.columnName")}
                  value={c.name}
                  maxLength={80}
                  onFocus={() => (typed.current = false)}
                  onChange={(e) => {
                    onceSnapshot();
                    setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                  }}
                />
                <input
                  className={styles.mini}
                  aria-label={t("panel.columnType")}
                  placeholder={t("panel.columnType")}
                  value={c.type}
                  maxLength={40}
                  onFocus={() => (typed.current = false)}
                  onChange={(e) => {
                    onceSnapshot();
                    setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)));
                  }}
                />
                <select
                  className={styles.mini}
                  aria-label={t("panel.columnKey")}
                  value={c.key ?? ""}
                  onChange={(e) => {
                    onSnapshot();
                    setColumns(columns.map((x, j) => (j === i ? { ...x, key: (e.target.value || null) as Column["key"] } : x)));
                  }}
                >
                  <option value="">—</option>
                  <option value="pk">PK</option>
                  <option value="fk">FK</option>
                </select>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={t("panel.removeColumn")}
                  onClick={() => {
                    onSnapshot();
                    setColumns(columns.filter((_, j) => j !== i));
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            <Button
              size="small"
              disabled={columns.length >= 80}
              onClick={() => {
                onSnapshot();
                setColumns([...columns, { name: "", type: "", key: null }]);
                onPatch((n) => ({ ...n, height: Math.max(n.height ?? 0, 60 + (columns.length + 1) * 22) }));
              }}
            >
              <Plus size={14} aria-hidden="true" /> {t("panel.addColumn")}
            </Button>
          </div>
        </div>
      )}
      <IssueLink
        base={base}
        issueId={node.data.issueId}
        chip={node.data.issueId ? issues[node.data.issueId] : undefined}
        onChange={(chip) => {
          onSnapshot();
          if (chip) onIssue(chip);
          setData({ issueId: chip?.id ?? null });
        }}
      />
      <Button size="small" variant="danger" onClick={onDelete}>
        <Trash2 size={14} aria-hidden="true" /> {t("panel.deleteNode")}
      </Button>
    </div>
  );
}

function IssueLink({ base, issueId, chip, onChange }: { base: string; issueId: string | null; chip?: IssueChip; onChange: (chip: IssueChip | null) => void }) {
  const t = useTranslations("diagrams.panel");
  const tStatus = useTranslations("common.status");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setQ(input.trim()), 250);
    return () => clearTimeout(h);
  }, [input]);
  const options = useQuery({
    queryKey: ["diagrams", "issue-options", base, q],
    queryFn: () => api.get<{ items: IssueOption[] }>(`${base}/diagram-issue-options?${new URLSearchParams({ q })}`),
    enabled: !issueId && q.length > 0,
    staleTime: 15_000,
  });
  const statusText = (o: { tone: string; status: string }) => (o.tone === "overdue" ? tStatus("overdue") : o.status);
  return (
    <div className={styles.field}>
      <span>
        {t("issue")} <em className={styles.optional}>{t("optional")}</em>
      </span>
      {issueId ? (
        <div className={styles.linked}>
          <span className={styles.linkedText}>
            <b>{chip?.key ?? t("hiddenIssue")}</b> {chip?.title}
            {chip && <span className={cn(styles.chip, styles[`tone_${chip.tone}`])}>{chip.deleted ? t("deletedIssue") : statusText(chip)}</span>}
          </span>
          <Button size="small" onClick={() => onChange(null)}>{t("unlink")}</Button>
        </div>
      ) : (
        <>
          <input className={styles.paletteSearch} placeholder={t("issueSearch")} aria-label={t("issueSearch")} value={input} onChange={(e) => setInput(e.target.value)} />
          {q && (
            <div className={styles.options} role="listbox" aria-label={t("issue")}>
              {options.isLoading ? (
                <div className={styles.optionEmpty}>{t("searching")}</div>
              ) : !options.data?.items.length ? (
                <div className={styles.optionEmpty}>{t("noIssue")}</div>
              ) : (
                options.data.items.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={styles.option}
                    onClick={() => onChange({ id: o.id, key: o.key, title: o.title, status: o.status, category: o.category, tone: o.tone, dueDate: null, deleted: false })}
                  >
                    <b>{o.key} {o.title}</b>
                    <small>
                      <span className={cn(styles.chip, styles[`tone_${o.tone}`])}>{statusText(o)}</span>
                      {o.assignee?.displayName}
                    </small>
                  </button>
                ))
              )}
            </div>
          )}
          <p className={styles.hint}>{t("issueHint")}</p>
        </>
      )}
    </div>
  );
}

function EdgePanel({ edge, er, onSnapshot, onPatch, onDelete }: { edge: FlowEdge; er: boolean; onSnapshot: () => void; onPatch: (d: Partial<EdgeData>) => void; onDelete: () => void }) {
  const t = useTranslations("diagrams.panel");
  const typed = useRef(false);
  return (
    <div className={styles.panelBody}>
      <h2 className={styles.panelTitle}>{t("edgeTitle")}</h2>
      <Input
        id="diagram-edge-label"
        label={t("edgeLabel")}
        placeholder={t("edgeLabelPlaceholder")}
        value={edge.data?.text ?? ""}
        maxLength={100}
        onFocus={() => (typed.current = false)}
        onChange={(e) => {
          if (!typed.current) onSnapshot();
          typed.current = true;
          onPatch({ text: e.target.value });
        }}
      />
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={!!edge.data?.dashed}
          onChange={(e) => {
            onSnapshot();
            onPatch({ dashed: e.target.checked });
          }}
        />
        {t("dashed")}
      </label>
      {er && (
        <Select
          size="small"
          label={t("cardinality")}
          value={edge.data?.cardinality ?? ""}
          onChange={(e) => {
            onSnapshot();
            onPatch({ cardinality: (e.target.value || undefined) as EdgeData["cardinality"] });
          }}
        >
          <option value="">{t("cardinalityNone")}</option>
          <option value="1-1">1 : 1</option>
          <option value="1-n">1 : N</option>
          <option value="n-n">N : N</option>
        </Select>
      )}
      <Button size="small" variant="danger" onClick={onDelete}>
        <Trash2 size={14} aria-hidden="true" /> {t("deleteEdge")}
      </Button>
    </div>
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
