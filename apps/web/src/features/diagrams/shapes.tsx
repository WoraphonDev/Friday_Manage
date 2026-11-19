"use client";

import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { IssueChip, NodeData, Shape } from "./types";
import styles from "./diagrams.module.css";

/** หมวดในแถบรูปทรงด้านซ้าย · ลำดับเดียวกับ storyboard */
export const SHAPE_GROUPS: { key: "flowchart" | "er" | "architecture" | "whiteboard"; shapes: Shape[] }[] = [
  { key: "flowchart", shapes: ["terminator", "process", "decision", "data", "document", "connector"] },
  { key: "er", shapes: ["table"] },
  { key: "architecture", shapes: ["service", "database", "queue", "actor", "external", "group"] },
  { key: "whiteboard", shapes: ["note", "text", "frame"] },
];

/** ขนาดเริ่มต้น · ต้องตรงกับ API (apps/api/src/diagrams/content.ts › defaultSize) เพื่อให้ภาพย่อในการ์ดตรงกับภาพจริง */
export function defaultSize(type: Shape): { w: number; h: number } {
  switch (type) {
    case "terminator": return { w: 160, h: 44 };
    case "decision": return { w: 150, h: 90 };
    case "connector": return { w: 48, h: 48 };
    case "table": return { w: 220, h: 140 };
    case "database": return { w: 120, h: 90 };
    case "actor": return { w: 90, h: 90 };
    case "group":
    case "frame": return { w: 360, h: 240 };
    case "note": return { w: 160, h: 120 };
    case "text": return { w: 160, h: 40 };
    default: return { w: 180, h: 60 };
  }
}
/** กรอบกลุ่ม / Frame อยู่ใต้กล่องอื่นเสมอ */
export const isContainer = (type: Shape) => type === "group" || type === "frame";

export interface DiagramCtx {
  editing: boolean;
  issues: Record<string, IssueChip>;
  openIssue: (key: string) => void;
  setLabel: (id: string, label: string) => void;
}
export const DiagramContext = createContext<DiagramCtx>({ editing: false, issues: {}, openIssue: () => {}, setLabel: () => {} });

type DiagramNode = Node<NodeData, Shape>;

/** รูปทรงที่วาดด้วย SVG ยืดตามขนาดกล่อง (เส้นไม่หนาขึ้นตามการยืด) */
function Outline({ type }: { type: Shape }) {
  const common = { className: styles.outline, viewBox: "0 0 100 100", preserveAspectRatio: "none" as const, "aria-hidden": true };
  switch (type) {
    case "decision":
      return <svg {...common}><polygon points="50,1 99,50 50,99 1,50" /></svg>;
    case "data":
      return <svg {...common}><polygon points="14,1 99,1 86,99 1,99" /></svg>;
    case "document":
      return <svg {...common}><path d="M1 1H99V84C80 70 66 100 46 92C30 86 18 80 1 90Z" /></svg>;
    case "database":
      return (
        <svg {...common}>
          <path d="M1 12C1 -2 99 -2 99 12V88C99 102 1 102 1 88Z" />
          <path d="M1 12C1 26 99 26 99 12" className={styles.outlineInner} />
        </svg>
      );
    case "queue":
      return (
        <svg {...common}>
          <path d="M8 1H92C102 1 102 99 92 99H8C-2 99 -2 1 8 1Z" />
          <path d="M92 1C82 1 82 99 92 99" className={styles.outlineInner} />
        </svg>
      );
    case "connector":
      return <svg {...common}><ellipse cx="50" cy="50" rx="49" ry="49" /></svg>;
    default:
      return null;
  }
}
const SVG_SHAPES = new Set<Shape>(["decision", "data", "document", "database", "queue", "connector"]);

function ActorIcon() {
  return (
    <svg className={styles.actorIcon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="6" r="3.5" />
      <path d="M12 10v6M6 13h12M12 16l-4 6M12 16l4 6" />
    </svg>
  );
}

function Chip({ issueId }: { issueId: string }) {
  const { issues, openIssue } = useContext(DiagramContext);
  const t = useTranslations("diagrams.chip");
  const tStatus = useTranslations("common.status");
  const chip = issues[issueId];
  if (!chip) return <span className={cn(styles.chip, styles.chipMuted)}>{t("hidden")}</span>;
  if (chip.deleted) return <span className={cn(styles.chip, styles.chipMuted)}>{chip.key} · {t("deleted")}</span>;
  const label = chip.tone === "overdue" ? tStatus("overdue") : chip.status;
  return (
    <button
      type="button"
      className={cn(styles.chip, styles[`tone_${chip.tone}`], "nodrag", "nopan")}
      title={t("open", { key: chip.key, title: chip.title })}
      onClick={(e) => {
        e.stopPropagation();
        openIssue(chip.key);
      }}
    >
      {chip.key} · {label}
    </button>
  );
}

/** ข้อความในกล่อง · ดับเบิลคลิกเพื่อพิมพ์ (เฉพาะตอนถือสิทธิ์แก้) */
function Label({ id, label, multiline = true, className }: { id: string; label: string; multiline?: boolean; className?: string }) {
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
    <span className={cn(styles.label, className, !label && editing && styles.placeholder)} onDoubleClick={() => editing && setTyping(true)}>
      {label || (editing ? t("doubleClick") : "")}
    </span>
  );
}

function Handles() {
  // ConnectionMode.Loose: จุดเดียวเป็นได้ทั้งต้นทางและปลายทาง · id ตรงกับ sourceHandle / targetHandle ที่บันทึก
  return (
    <>
      <Handle type="source" position={Position.Top} id="t" className={styles.handle} />
      <Handle type="source" position={Position.Right} id="r" className={styles.handle} />
      <Handle type="source" position={Position.Bottom} id="b" className={styles.handle} />
      <Handle type="source" position={Position.Left} id="l" className={styles.handle} />
    </>
  );
}

function Frame({ children, type, data, selected, className }: { children: ReactNode; type: Shape; data: NodeData; selected: boolean; className?: string }) {
  const { editing, issues } = useContext(DiagramContext);
  const tone = data.issueId ? (issues[data.issueId]?.tone ?? null) : null;
  const size = defaultSize(type);
  return (
    <div
      className={cn(
        styles.node,
        styles[`shape_${type}`],
        styles[`color_${data.color}`],
        SVG_SHAPES.has(type) && styles.svgShape,
        tone && styles[`border_${tone}`],
        selected && styles.selected,
        className,
      )}
    >
      {editing && <NodeResizer isVisible={selected} minWidth={Math.min(40, size.w)} minHeight={Math.min(30, size.h)} lineClassName={styles.resizeLine} handleClassName={styles.resizeHandle} />}
      <Outline type={type} />
      {children}
      {data.issueId && <Chip issueId={data.issueId} />}
      <Handles />
    </div>
  );
}

function BasicNode({ id, type, data, selected }: NodeProps<DiagramNode>) {
  return (
    <Frame type={type} data={data} selected={!!selected}>
      {type === "actor" && <ActorIcon />}
      <Label id={id} label={data.label} />
    </Frame>
  );
}

function TableNode({ id, type, data, selected }: NodeProps<DiagramNode>) {
  return (
    <Frame type={type} data={data} selected={!!selected}>
      <div className={styles.tableHead}>
        <Label id={id} label={data.label} multiline={false} />
      </div>
      <div className={cn(styles.tableRows, "nowheel")}>
        {(data.columns ?? []).map((c, i) => (
          <div key={i} className={styles.tableRow}>
            <span className={styles.colKey}>{c.key ? c.key.toUpperCase() : ""}</span>
            <span className={styles.colName}>{c.name}</span>
            <span className={styles.colType}>{c.type}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function ContainerNode({ id, type, data, selected }: NodeProps<DiagramNode>) {
  return (
    <Frame type={type} data={data} selected={!!selected}>
      <Label id={id} label={data.label} multiline={false} className={styles.containerLabel} />
    </Frame>
  );
}

const basic = memo(BasicNode);
const container = memo(ContainerNode);
export const nodeTypes = {
  terminator: basic, process: basic, decision: basic, data: basic, document: basic, connector: basic,
  table: memo(TableNode),
  service: basic, database: basic, queue: basic, actor: basic, external: basic, group: container,
  note: basic, text: basic, frame: container,
};

/** ไอคอนเล็กในแถบรูปทรง */
export function ShapeIcon({ type }: { type: Shape }) {
  const p = { className: styles.paletteIcon, viewBox: "0 0 34 22", "aria-hidden": true as const };
  switch (type) {
    case "terminator": return <svg {...p}><rect x="3" y="5" width="28" height="12" rx="6" /></svg>;
    case "process": return <svg {...p}><rect x="4" y="4" width="26" height="14" rx="2" /></svg>;
    case "decision": return <svg {...p}><path d="M17 2l14 9-14 9-14-9z" /></svg>;
    case "data": return <svg {...p}><path d="M8 4h24l-6 14H2z" /></svg>;
    case "document": return <svg {...p}><path d="M5 3h24v13c-5-3-8 4-13 2s-7-2-11 0z" /></svg>;
    case "connector": return <svg {...p}><circle cx="17" cy="11" r="7" /></svg>;
    case "table": return <svg {...p}><rect x="6" y="2" width="22" height="18" rx="2" /><path d="M6 8h22" /></svg>;
    case "service": return <svg {...p}><rect x="5" y="4" width="24" height="14" rx="3" /><path d="M10 11h14" /></svg>;
    case "database": return <svg {...p}><ellipse cx="17" cy="5" rx="9" ry="3" /><path d="M8 5v12c0 4 18 4 18 0V5" /></svg>;
    case "queue": return <svg {...p}><rect x="4" y="5" width="26" height="12" rx="6" /><path d="M24 5c-3 0-3 12 0 12" /></svg>;
    case "actor": return <svg {...p}><circle cx="17" cy="5" r="3" /><path d="M17 8v6M12 11h10M17 14l-4 6M17 14l4 6" /></svg>;
    case "external": return <svg {...p}><rect x="4" y="4" width="26" height="14" rx="2" strokeDasharray="3 2" /></svg>;
    case "group": return <svg {...p}><rect x="3" y="2" width="28" height="18" rx="3" strokeDasharray="3 2" /></svg>;
    case "note": return <svg {...p}><rect x="9" y="2" width="16" height="18" className={styles.paletteNote} /></svg>;
    case "text": return <svg {...p}><path d="M11 5h12M17 5v13" /></svg>;
    case "frame": return <svg {...p}><rect x="3" y="4" width="28" height="16" rx="2" /><path d="M3 4h10" strokeWidth="3" /></svg>;
  }
}
