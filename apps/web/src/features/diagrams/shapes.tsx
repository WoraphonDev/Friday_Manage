"use client";

import { createContext, memo, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, NodeResizer, NodeToolbar, Position, type Node, type NodeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { DiagramIcon } from "./icons";
import { columnTypeText, isFk, isPk, type Column, type IssueChip, type NodeColor, type NodeData, type Shape, type Tone } from "./types";
import styles from "./diagrams.module.css";

export type GroupKey = "flowchart" | "swimlane" | "uml" | "architecture" | "er" | "whiteboard";
type Kind = "box" | "svg" | "icon" | "stick" | "container" | "lane" | "pool" | "table" | "enum" | "class" | "lifeline" | "text" | "note" | "point" | "annotation";

interface ShapeDef {
  group: GroupKey;
  kind: Kind;
  size: { w: number; h: number };
  /** ไอคอนประจำรูปทรง (สถาปัตยกรรม) · ผู้ใช้เปลี่ยนเองได้ */
  icon?: string;
  /** สไตล์กล่องเพิ่มเติมของแบบ box */
  variant?: "pill" | "round" | "dashed" | "plain";
}

/** ขนาดเริ่มต้นต้องตรงกับ API (apps/api/src/diagrams/content.ts › defaultSize) ให้ภาพย่อในการ์ดตรงกับภาพจริง */
export const SHAPE_DEFS: Record<Shape, ShapeDef> = {
  terminator: { group: "flowchart", kind: "box", variant: "pill", size: { w: 160, h: 44 } },
  process: { group: "flowchart", kind: "box", size: { w: 180, h: 60 } },
  decision: { group: "flowchart", kind: "svg", size: { w: 150, h: 90 } },
  data: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  document: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  "multi-document": { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  subprocess: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  "manual-input": { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  "manual-operation": { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  preparation: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  delay: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  merge: { group: "flowchart", kind: "svg", size: { w: 56, h: 56 } },
  connector: { group: "flowchart", kind: "svg", size: { w: 56, h: 56 } },
  "off-page": { group: "flowchart", kind: "svg", size: { w: 56, h: 64 } },
  "stored-data": { group: "flowchart", kind: "svg", size: { w: 120, h: 90 } },
  display: { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  "loop-limit": { group: "flowchart", kind: "svg", size: { w: 180, h: 60 } },
  annotation: { group: "flowchart", kind: "annotation", size: { w: 160, h: 44 } },
  "lane-h": { group: "swimlane", kind: "lane", size: { w: 720, h: 160 } },
  "lane-v": { group: "swimlane", kind: "lane", size: { w: 220, h: 480 } },
  pool: { group: "swimlane", kind: "pool", size: { w: 760, h: 360 } },
  "uml-class": { group: "uml", kind: "class", size: { w: 200, h: 140 } },
  "uml-interface": { group: "uml", kind: "class", size: { w: 200, h: 140 } },
  "uml-actor": { group: "uml", kind: "stick", size: { w: 90, h: 100 } },
  "uml-usecase": { group: "uml", kind: "svg", size: { w: 170, h: 70 } },
  "uml-component": { group: "uml", kind: "icon", icon: "box", size: { w: 180, h: 60 } },
  "uml-package": { group: "uml", kind: "svg", size: { w: 200, h: 120 } },
  "uml-lifeline": { group: "uml", kind: "lifeline", size: { w: 140, h: 320 } },
  "uml-state": { group: "uml", kind: "box", variant: "round", size: { w: 180, h: 60 } },
  actor: { group: "architecture", kind: "stick", size: { w: 90, h: 100 } },
  "web-app": { group: "architecture", kind: "icon", icon: "app-window", size: { w: 130, h: 90 } },
  "mobile-app": { group: "architecture", kind: "icon", icon: "smartphone", size: { w: 130, h: 90 } },
  service: { group: "architecture", kind: "icon", icon: "boxes", size: { w: 130, h: 90 } },
  database: { group: "architecture", kind: "svg", size: { w: 120, h: 90 } },
  cache: { group: "architecture", kind: "icon", icon: "zap", size: { w: 130, h: 90 } },
  queue: { group: "architecture", kind: "svg", size: { w: 180, h: 60 } },
  storage: { group: "architecture", kind: "icon", icon: "hard-drive", size: { w: 130, h: 90 } },
  server: { group: "architecture", kind: "icon", icon: "server", size: { w: 130, h: 90 } },
  "load-balancer": { group: "architecture", kind: "icon", icon: "network", size: { w: 130, h: 90 } },
  cdn: { group: "architecture", kind: "icon", icon: "globe", size: { w: 130, h: 90 } },
  cloud: { group: "architecture", kind: "svg", size: { w: 160, h: 100 } },
  external: { group: "architecture", kind: "box", variant: "dashed", size: { w: 180, h: 60 } },
  firewall: { group: "architecture", kind: "icon", icon: "shield-check", size: { w: 130, h: 90 } },
  group: { group: "architecture", kind: "container", variant: "dashed", size: { w: 360, h: 240 } },
  table: { group: "er", kind: "table", size: { w: 220, h: 140 } },
  "er-view": { group: "er", kind: "table", variant: "dashed", size: { w: 220, h: 140 } },
  "er-enum": { group: "er", kind: "enum", size: { w: 160, h: 120 } },
  note: { group: "whiteboard", kind: "note", size: { w: 160, h: 120 } },
  text: { group: "whiteboard", kind: "text", size: { w: 160, h: 44 } },
  frame: { group: "whiteboard", kind: "container", size: { w: 360, h: 240 } },
  rect: { group: "whiteboard", kind: "box", variant: "plain", size: { w: 140, h: 90 } },
  circle: { group: "whiteboard", kind: "svg", size: { w: 100, h: 100 } },
  triangle: { group: "whiteboard", kind: "svg", size: { w: 110, h: 100 } },
  point: { group: "whiteboard", kind: "point", size: { w: 12, h: 12 } },
};

export const defaultSize = (type: Shape) => SHAPE_DEFS[type]?.size ?? { w: 180, h: 60 };
/** กรอบ / Lane / Pool อยู่ใต้กล่องอื่นเสมอ และลากแล้วกล่องข้างในย้ายตาม */
export const isContainer = (type: Shape) => ["group", "frame", "lane-h", "lane-v", "pool"].includes(type);

/** รายการในคลังรูปทรง · โน้ตมีหลายสีให้หยิบได้ทันที */
export interface PaletteItem {
  key: string;
  type: Shape;
  preset?: Partial<NodeData>;
}
const NOTE_COLORS: NodeColor[] = ["yellow", "pink", "green", "blue", "purple"];
export const SHAPE_GROUPS: { key: GroupKey; items: PaletteItem[] }[] = [
  { key: "flowchart", items: (["terminator", "process", "decision", "data", "document", "multi-document", "subprocess", "manual-input", "manual-operation", "preparation", "delay", "merge", "connector", "off-page", "stored-data", "display", "loop-limit", "annotation"] as Shape[]).map((type) => ({ key: type, type })) },
  { key: "swimlane", items: (["lane-h", "lane-v", "pool"] as Shape[]).map((type) => ({ key: type, type })) },
  { key: "uml", items: (["uml-class", "uml-interface", "uml-actor", "uml-usecase", "uml-component", "uml-package", "uml-lifeline", "uml-state"] as Shape[]).map((type) => ({ key: type, type })) },
  { key: "architecture", items: (["actor", "web-app", "mobile-app", "service", "database", "cache", "queue", "storage", "server", "load-balancer", "cdn", "cloud", "external", "firewall", "group"] as Shape[]).map((type) => ({ key: type, type })) },
  { key: "er", items: (["table", "er-view", "er-enum"] as Shape[]).map((type) => ({ key: type, type })) },
  {
    key: "whiteboard",
    items: [
      ...NOTE_COLORS.map((color) => ({ key: `note-${color}`, type: "note" as Shape, preset: { color } })),
      ...(["text", "frame", "rect", "circle", "triangle"] as Shape[]).map((type) => ({ key: type, type })),
    ],
  },
];

// ---------------------------------------------------------------------------
// บริบทที่กล่องใช้ร่วมกัน
// ---------------------------------------------------------------------------
export interface DiagramCtx {
  editing: boolean;
  issues: Record<string, IssueChip>;
  openIssue: (key: string) => void;
  setLabel: (id: string, label: string) => void;
  /** กล่องที่เปิดรายการงานอยู่ (กดป้าย) */
  openTag: string | null;
  setOpenTag: (id: string | null) => void;
  /** กล่องที่งานกำลังถูกลากมาวางทับ */
  dropTarget: string | null;
}
export const DiagramContext = createContext<DiagramCtx>({ editing: false, issues: {}, openIssue: () => {}, setLabel: () => {}, openTag: null, setOpenTag: () => {}, dropTarget: null });

type DiagramNode = Node<NodeData, Shape>;

/** สถานะที่ต้องเห็นก่อนเมื่อกล่องผูกหลายงาน */
const TONE_ORDER: Tone[] = ["overdue", "blocked", "in_progress", "review", "todo", "done", "cancelled", "deleted"];
export function sortChips(chips: IssueChip[]) {
  return [...chips].sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));
}

// ---------------------------------------------------------------------------
// รูปทรงที่วาดด้วย SVG (ยืดตามกล่อง เส้นไม่หนาขึ้นตามการยืด)
// ---------------------------------------------------------------------------
export function OutlinePaths({ type }: { type: Shape }): ReactNode {
  switch (type) {
    case "decision": return <polygon points="50,1 99,50 50,99 1,50" />;
    case "data": return <polygon points="14,1 99,1 86,99 1,99" />;
    case "document": return <path d="M1 1H99V84C80 70 66 100 46 92C30 86 18 80 1 90Z" />;
    case "multi-document": return <><path d="M9 1H99V74C82 62 70 88 52 81C38 76 26 72 9 80Z" /><path d="M1 12H91V86C74 74 62 100 44 93C30 88 18 84 1 92Z" /></>;
    case "subprocess": return <><rect x="1" y="1" width="98" height="98" /><path d="M11 1V99M89 1V99" className={styles.outlineInner} /></>;
    case "manual-input": return <polygon points="1,28 99,1 99,99 1,99" />;
    case "manual-operation": return <polygon points="1,1 99,1 84,99 16,99" />;
    case "preparation": return <polygon points="14,1 86,1 99,50 86,99 14,99 1,50" />;
    case "delay": return <path d="M1 1H62C90 1 99 25 99 50C99 75 90 99 62 99H1Z" />;
    case "merge": return <polygon points="1,1 99,1 50,99" />;
    case "connector":
    case "circle":
    case "uml-usecase": return <ellipse cx="50" cy="50" rx="49" ry="49" />;
    case "off-page": return <polygon points="1,1 99,1 99,66 50,99 1,66" />;
    case "stored-data":
    case "database": return <><path d="M1 12C1 -2 99 -2 99 12V88C99 102 1 102 1 88Z" /><path d="M1 12C1 26 99 26 99 12" className={styles.outlineInner} /></>;
    case "display": return <path d="M16 1H80C96 1 99 30 99 50C99 70 96 99 80 99H16L1 50Z" />;
    case "loop-limit": return <polygon points="16,1 84,1 99,24 99,99 1,99 1,24" />;
    case "queue": return <><path d="M8 1H92C102 1 102 99 92 99H8C-2 99 -2 1 8 1Z" /><path d="M92 1C82 1 82 99 92 99" className={styles.outlineInner} /></>;
    case "cloud": return <path d="M25 92C10 92 1 80 3 66C5 54 14 48 24 49C22 30 36 16 54 18C68 19 78 30 80 42C92 42 99 52 99 64C99 80 88 92 74 92Z" />;
    case "triangle": return <polygon points="50,1 99,99 1,99" />;
    case "uml-package": return <><path d="M1 16H99V99H1Z" /><path d="M1 16V1H42V16" /></>;
    default: return null;
  }
}

function Outline({ type }: { type: Shape }) {
  return (
    <svg className={styles.outline} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <OutlinePaths type={type} />
    </svg>
  );
}

function StickFigure() {
  return (
    <svg className={styles.actorIcon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="3.5" />
      <path d="M12 9v7M6 12h12M12 16l-4 6M12 16l4 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ป้ายงานใต้กล่อง + รายการงาน
// ---------------------------------------------------------------------------
function TaskTag({ nodeId, issueIds, label }: { nodeId: string; issueIds: string[]; label: string }) {
  const { issues, openTag, setOpenTag, openIssue } = useContext(DiagramContext);
  const t = useTranslations("diagrams.tag");
  const tStatus = useTranslations("common.status");
  const chips = issueIds.map((id) => issues[id]).filter((c): c is IssueChip => !!c);
  const hidden = issueIds.length - chips.length;
  const overdue = chips.filter((c) => c.tone === "overdue").length;
  const done = chips.filter((c) => c.tone === "done").length;
  const statusText = (c: IssueChip) => (c.deleted ? t("deleted") : c.tone === "overdue" ? tStatus("overdue") : c.status);
  const sorted = sortChips(chips);
  let text: string;
  if (issueIds.length === 1) text = chips[0] ? `${chips[0].key} · ${statusText(chips[0])}` : t("hidden");
  else text = [t("count", { n: issueIds.length }), overdue ? t("overdue", { n: overdue }) : done === issueIds.length ? t("allDone") : ""].filter(Boolean).join(" · ");
  const open = openTag === nodeId;
  return (
    <>
      <button
        type="button"
        className={cn(styles.tag, overdue > 0 && styles.tagOver, "nodrag", "nopan")}
        aria-expanded={open}
        title={t("open")}
        onClick={(e) => {
          e.stopPropagation();
          setOpenTag(open ? null : nodeId);
        }}
      >
        <span className={styles.tagDots} aria-hidden="true">
          {sorted.slice(0, 5).map((c) => <i key={c.id} className={styles[`dot_${c.tone}`]} />)}
          {hidden > 0 && chips.length < 5 && <i className={styles.dot_cancelled} />}
        </span>
        <span>{issueIds.length > 1 && overdue > 0 ? <>{t("count", { n: issueIds.length })} · <span className={styles.tagOverText}>{t("overdue", { n: overdue })}</span></> : text}</span>
      </button>
      <NodeToolbar nodeId={nodeId} isVisible={open} position={Position.Bottom} offset={22} className={cn(styles.pop, "nodrag", "nopan", "nowheel")}>
        <div className={styles.popHead}>
          <b>{t("title", { name: label || t("untitled"), n: issueIds.length })}</b>
          <button type="button" className={styles.popClose} aria-label={t("close")} onClick={() => setOpenTag(null)}>×</button>
        </div>
        {issueIds.length > 1 && <Progress chips={chips} total={issueIds.length} />}
        <div className={styles.popList}>
          {sorted.map((c) => (
            <button key={c.id} type="button" className={styles.popRow} onClick={() => !c.deleted && openIssue(c.key)} disabled={c.deleted}>
              <i className={cn(styles.dot, styles[`dot_${c.tone}`])} aria-hidden="true" />
              <b>{c.key}</b>
              <span className={styles.popTitle}>{c.title}</span>
              <span className={cn(styles.chip, styles[`tone_${c.tone}`])}>{statusText(c)}</span>
            </button>
          ))}
          {hidden > 0 && <div className={styles.popHidden}>{t("hiddenCount", { n: hidden })}</div>}
        </div>
      </NodeToolbar>
    </>
  );
}

/** แถบความคืบหน้าของงานที่ผูก (เสร็จ / กำลังทำ / เลยกำหนด) */
export function Progress({ chips, total }: { chips: IssueChip[]; total: number }) {
  const t = useTranslations("diagrams.tag");
  const done = chips.filter((c) => c.tone === "done").length;
  const parts = sortChips(chips).reverse();
  return (
    <div className={styles.progress}>
      <span>{t("progress", { done, total })}</span>
      <span className={styles.progressBar} aria-hidden="true">
        {parts.map((c) => <i key={c.id} className={styles[`dot_${c.tone}`]} style={{ width: `${100 / total}%` }} />)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ข้อความในกล่อง (ดับเบิลคลิกเพื่อพิมพ์ตอนแก้)
// ---------------------------------------------------------------------------
function Label({ id, label, multiline = true, className, style }: { id: string; label: string; multiline?: boolean; className?: string; style?: CSSProperties }) {
  const { editing, setLabel } = useContext(DiagramContext);
  const t = useTranslations("diagrams.editor");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(label);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!typing) setDraft(label);
  }, [label, typing]);
  useEffect(() => {
    if (typing) ref.current?.select();
  }, [typing]);
  if (editing && typing) {
    return (
      <textarea
        ref={ref}
        className={cn(styles.labelInput, "nodrag", "nopan", "nowheel")}
        style={style}
        value={draft}
        aria-label={t("label")}
        rows={multiline ? 3 : 1}
        maxLength={500}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setTyping(false);
          if (draft !== label) setLabel(id, draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(label);
            setTyping(false);
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
    );
  }
  return (
    <span className={cn(styles.label, className, !label && editing && styles.placeholder)} style={style} onDoubleClick={() => editing && setTyping(true)}>
      {label || (editing ? t("doubleClick") : "")}
    </span>
  );
}

function Handles({ center = false }: { center?: boolean }) {
  // ConnectionMode.Loose: จุดเดียวเป็นได้ทั้งต้นทางและปลายทาง · id ตรงกับ sourceHandle / targetHandle ที่บันทึก
  if (center) return <Handle type="source" position={Position.Top} id="c" className={cn(styles.handle, styles.handleCenter)} />;
  return (
    <>
      <Handle type="source" position={Position.Top} id="t" className={styles.handle} />
      <Handle type="source" position={Position.Right} id="r" className={styles.handle} />
      <Handle type="source" position={Position.Bottom} id="b" className={styles.handle} />
      <Handle type="source" position={Position.Left} id="l" className={styles.handle} />
    </>
  );
}

function labelStyle(data: NodeData): CSSProperties {
  return {
    ...(data.fontSize ? { fontSize: `${data.fontSize}px` } : {}),
    ...(data.bold ? { fontWeight: 700 } : {}),
    ...(data.align ? { textAlign: data.align } : {}),
  };
}

// ---------------------------------------------------------------------------
// กล่อง
// ---------------------------------------------------------------------------
function NodeView({ id, type, data, selected }: NodeProps<DiagramNode>) {
  const { editing, dropTarget } = useContext(DiagramContext);
  const shape = type as Shape;
  const def = SHAPE_DEFS[shape] ?? SHAPE_DEFS.process;
  const t = useTranslations("diagrams");
  const ls = labelStyle(data);
  const issueIds = data.issueIds ?? [];
  const svg = def.kind === "svg";

  if (def.kind === "point") {
    return (
      <div className={cn(styles.point, selected && styles.pointSelected, !editing && styles.pointView)}>
        <Handles center />
      </div>
    );
  }

  let body: ReactNode;
  switch (def.kind) {
    case "stick":
      body = <><StickFigure /><Label id={id} label={data.label} style={ls} /></>;
      break;
    case "icon":
      body = <><DiagramIcon name={data.icon ?? def.icon} size={26} className={styles.shapeIcon} /><Label id={id} label={data.label} style={ls} /></>;
      break;
    case "container":
      body = <Label id={id} label={data.label} multiline={false} className={styles.containerLabel} style={ls} />;
      break;
    case "lane":
      body = (
        <>
          <div className={styles.laneHead}><Label id={id} label={data.label} multiline={false} style={ls} /></div>
          <div className={styles.laneBody} />
        </>
      );
      break;
    case "pool": {
      const lanes = data.lanes?.length ? data.lanes : [t("defaults.lane", { n: 1 }), t("defaults.lane", { n: 2 })];
      body = (
        <>
          <div className={styles.poolHead}><Label id={id} label={data.label} multiline={false} style={ls} /></div>
          <div className={styles.poolLanes}>
            {lanes.map((name, i) => (
              <div key={i} className={styles.poolLane}>
                <div className={styles.laneHead}><span className={styles.label}>{name}</span></div>
                <div className={styles.laneBody} />
              </div>
            ))}
          </div>
        </>
      );
      break;
    }
    case "table":
      body = (
        <>
          <div className={styles.tableHead}>
            {def.variant === "dashed" && <span className={styles.stereo}>«view»</span>}
            <Label id={id} label={data.label} multiline={false} style={ls} />
          </div>
          <div className={cn(styles.tableRows, "nowheel")}>
            {(data.columns ?? []).map((c, i) => (
              <div key={i} className={styles.tableRow}>
                <ColumnKeys column={c} />
                <span className={styles.colName}>{c.name}</span>
                <span className={styles.colType}>
                  <span>{columnTypeText(c)}</span>
                  {c.defaultValue && <span className={styles.colDefault} title={`DEFAULT ${c.defaultValue}`}>= {c.defaultValue}</span>}
                  {c.nullable && c.key !== "pk" && <span className={styles.colNull}>NULL</span>}
                </span>
              </div>
            ))}
          </div>
        </>
      );
      break;
    case "enum":
      body = (
        <>
          <div className={styles.tableHead}><span className={styles.stereo}>«enum»</span><Label id={id} label={data.label} multiline={false} style={ls} /></div>
          <div className={cn(styles.tableRows, "nowheel")}>
            {(data.columns ?? []).map((c, i) => <div key={i} className={styles.enumRow}>{c.name}</div>)}
          </div>
        </>
      );
      break;
    case "class": {
      const sections = (data.body ?? "").split(/^---$/m);
      body = (
        <>
          <div className={styles.tableHead}>
            {shape === "uml-interface" && <span className={styles.stereo}>«interface»</span>}
            <Label id={id} label={data.label} multiline={false} style={ls} />
          </div>
          {sections.map((sec, i) => <div key={i} className={styles.classSection}>{sec.replace(/^\n|\n$/g, "")}</div>)}
        </>
      );
      break;
    }
    case "lifeline":
      body = (
        <>
          <div className={styles.lifeHead}><Label id={id} label={data.label} multiline={false} style={ls} /></div>
          <div className={styles.lifeLine} />
        </>
      );
      break;
    case "annotation":
      body = <><svg className={styles.outline} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M14 1H1V99H14" className={styles.bracket} /></svg><Label id={id} label={data.label} style={ls} /></>;
      break;
    default:
      body = (
        <>
          {data.icon && <DiagramIcon name={data.icon} size={18} className={styles.shapeIcon} />}
          <Label id={id} label={data.label} style={ls} />
        </>
      );
  }

  return (
    <div
      className={cn(
        styles.node,
        styles[`kind_${def.kind}`],
        styles[`shape_${shape}`],
        def.variant && styles[`variant_${def.variant}`],
        styles[`color_${data.color ?? "default"}`],
        data.stroke && styles[`stroke_${data.stroke}`],
        data.strokeStyle && styles[`line_${data.strokeStyle}`],
        svg && styles.svgShape,
        selected && styles.selected,
        dropTarget === id && styles.dropTarget,
      )}
    >
      {editing && !data.locked && (
        <NodeResizer isVisible={!!selected} minWidth={Math.min(40, def.size.w)} minHeight={Math.min(30, def.size.h)} lineClassName={styles.resizeLine} handleClassName={styles.resizeHandle} />
      )}
      {svg && <Outline type={shape} />}
      {shape === "uml-component" && <span className={styles.compMark} aria-hidden="true" />}
      {body}
      {issueIds.length > 0 && <TaskTag nodeId={id} issueIds={issueIds} label={data.label} />}
      {data.locked && editing && <span className={styles.lockMark} title={t("panel.locked")}><Lock size={11} aria-label={t("panel.locked")} /></span>}
      <Handles />
    </div>
  );
}

const view = memo(NodeView);
export const nodeTypes = Object.fromEntries(Object.keys(SHAPE_DEFS).map((k) => [k, view])) as Record<Shape, typeof view>;

/** ไอคอนเล็กในคลังรูปทรง: ใช้เส้นชุดเดียวกับกล่องจริง */
export function ShapeIcon({ item }: { item: PaletteItem }) {
  const def = SHAPE_DEFS[item.type];
  const color = item.preset?.color ?? (item.type === "note" ? "yellow" : "default");
  if (def.kind === "svg") {
    return (
      <svg className={cn(styles.paletteIcon, styles[`color_${color}`])} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <g transform="translate(14 8) scale(.72 .84)"><OutlinePaths type={item.type} /></g>
      </svg>
    );
  }
  if (def.kind === "icon") return <span className={styles.paletteGlyph}><DiagramIcon name={def.icon} size={18} /></span>;
  if (def.kind === "stick") return <span className={styles.paletteGlyph}><StickFigure /></span>;
  return <span className={cn(styles.paletteBox, styles[`pb_${def.kind}`], def.variant && styles[`pbv_${def.variant}`], styles[`color_${color}`])} aria-hidden="true" />;
}

/** ป้ายคีย์หน้าชื่อคอลัมน์ · PK / FK / UQ สีต่างกัน (PK เป็น Unique อยู่แล้วจึงไม่แสดง UQ ซ้ำ) */
export function ColumnKeys({ column: c }: { column: Column }) {
  const pk = isPk(c);
  return (
    <span className={styles.colKey}>
      {pk && <span className={styles.colPk}>PK</span>}
      {isFk(c) && <span className={styles.colFk}>FK</span>}
      {c.unique && !pk && <span className={styles.colUq}>UQ</span>}
    </span>
  );
}
