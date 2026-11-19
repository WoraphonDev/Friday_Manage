"use client";

import { createContext, memo, useContext, type ReactNode } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { COLORS, MARKERS, type ContentEdge, type Marker, type NodeColor } from "./types";
import styles from "./diagrams.module.css";

export type EdgeData = {
  text?: string;
  cardinality?: ContentEdge["cardinality"];
  dashed?: boolean;
  path?: ContentEdge["path"];
  markerStart?: Marker;
  markerEnd?: Marker;
  width?: number;
  color?: NodeColor;
  bend?: { x: number; y: number };
};
export type FlowEdge = Edge<EdgeData, "diagram">;

export interface EdgeCtx {
  editing: boolean;
  /** เริ่มดัดเส้น (เก็บ undo) */
  onBendStart: () => void;
  setBend: (id: string, bend: { x: number; y: number } | undefined) => void;
  /** แถบลอยของเส้นที่เลือก (แสดงเมื่อเลือกเส้นเดียว) */
  toolbar: (edge: { id: string; data?: EdgeData }) => ReactNode;
  selectedOnly: string | null;
}
export const EdgeContext = createContext<EdgeCtx>({ editing: false, onBendStart: () => {}, setBend: () => {}, toolbar: () => null, selectedOnly: null });

/** ER แบบเดิม (cardinality) → หัวเส้นตีนกา */
export function markersOf(d: EdgeData | undefined): { start: Marker; end: Marker } {
  if (d?.markerStart || d?.markerEnd) return { start: d.markerStart ?? "none", end: d.markerEnd ?? "none" };
  if (d?.cardinality === "1-1") return { start: "one", end: "one" };
  if (d?.cardinality === "1-n") return { start: "one", end: "many" };
  if (d?.cardinality === "n-n") return { start: "many", end: "many" };
  return { start: "none", end: "arrow" };
}
const markerUrl = (m: Marker, color: NodeColor, selected: boolean) => (m === "none" ? undefined : `url(#dm-${m}-${selected ? "sel" : color})`);

function DiagramEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, label }: EdgeProps<FlowEdge>) {
  const { editing, onBendStart, setBend, toolbar, selectedOnly } = useContext(EdgeContext);
  const { screenToFlowPosition } = useReactFlow();
  const t = useTranslations("diagrams.edge");
  const color = data?.color ?? "default";
  let path: string;
  let lx: number;
  let ly: number;
  if (data?.bend) {
    // เส้นโค้งผ่านจุดที่ผู้ใช้ดัด: จุดควบคุมของ quadratic = 2·bend − กึ่งกลาง
    const cx = 2 * data.bend.x - (sourceX + targetX) / 2;
    const cy = 2 * data.bend.y - (sourceY + targetY) / 2;
    path = `M${sourceX},${sourceY} Q${cx},${cy} ${targetX},${targetY}`;
    lx = data.bend.x;
    ly = data.bend.y;
  } else if (data?.path === "straight") {
    [path, lx, ly] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  } else if (data?.path === "bezier") {
    [path, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  } else {
    [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  const { start, end } = markersOf(data);
  const strokeVar = selected ? "var(--primary)" : `var(--edge-${color})`;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerUrl(start, color, !!selected)}
        markerEnd={markerUrl(end, color, !!selected)}
        style={{ stroke: strokeVar, strokeWidth: (data?.width ?? 1.5) + (selected ? 0.5 : 0), strokeDasharray: data?.dashed ? "6 4" : undefined }}
        interactionWidth={18}
      />
      <EdgeLabelRenderer>
        {label && (
          <div className={cn(styles.edgeLabel, "nopan")} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {label}
          </div>
        )}
        {editing && selected && (
          <button
            type="button"
            className={cn(styles.bendHandle, "nodrag", "nopan")}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + (label ? 16 : 0)}px)` }}
            title={t("bend")}
            aria-label={t("bend")}
            onDoubleClick={() => {
              onBendStart();
              setBend(id, undefined);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              onBendStart();
              const move = (ev: PointerEvent) => setBend(id, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        )}
        {editing && selectedOnly === id && (
          <div className={cn(styles.edgeToolbarWrap, "nodrag", "nopan")} style={{ transform: `translate(-50%, -100%) translate(${lx}px, ${ly - 22}px)` }}>
            {toolbar({ id, data })}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
export const edgeTypes = { diagram: memo(DiagramEdgeView) };

/** หัวเส้นทุกแบบ × ทุกสี (SVG marker ใช้สีของเส้นตรง ๆ ไม่ได้ในทุกเบราว์เซอร์) */
export function EdgeMarkers() {
  const colors: (NodeColor | "sel")[] = [...COLORS, "sel"];
  return (
    <svg className={styles.markerDefs} aria-hidden="true">
      <defs>
        {colors.map((c) =>
          MARKERS.filter((m) => m !== "none").map((m) => {
            const stroke = c === "sel" ? "var(--primary)" : `var(--edge-${c})`;
            const common = { id: `dm-${m}-${c}`, markerUnits: "strokeWidth" as const, orient: "auto-start-reverse" };
            switch (m) {
              case "arrow":
                return <marker key={common.id} {...common} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6"><path d="M0 0L10 5L0 10z" fill={stroke} /></marker>;
              case "open":
                return <marker key={common.id} {...common} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"><path d="M1 1L9 5L1 9" fill="none" stroke={stroke} strokeWidth="1.4" /></marker>;
              case "circle":
                return <marker key={common.id} {...common} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6"><circle cx="5" cy="5" r="3.6" fill="var(--card)" stroke={stroke} strokeWidth="1.4" /></marker>;
              case "diamond":
                return <marker key={common.id} {...common} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="8" markerHeight="8"><path d="M1 6L6 1L11 6L6 11z" fill={stroke} /></marker>;
              case "one":
                return <marker key={common.id} {...common} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="9" markerHeight="9"><path d="M6 1V11M9 1V11" stroke={stroke} strokeWidth="1.2" fill="none" /></marker>;
              case "many":
                return <marker key={common.id} {...common} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="9" markerHeight="9"><path d="M11 1L3 6L11 11M3 6H11" stroke={stroke} strokeWidth="1.2" fill="none" /></marker>;
              case "zero-many":
                return <marker key={common.id} {...common} viewBox="0 0 16 12" refX="15" refY="6" markerWidth="12" markerHeight="9"><circle cx="3.5" cy="6" r="2.5" fill="var(--card)" stroke={stroke} strokeWidth="1.2" /><path d="M15 1L7 6L15 11M7 6H15" stroke={stroke} strokeWidth="1.2" fill="none" /></marker>;
              case "one-many":
                return <marker key={common.id} {...common} viewBox="0 0 16 12" refX="15" refY="6" markerWidth="12" markerHeight="9"><path d="M4 1V11M15 1L7 6L15 11M7 6H15" stroke={stroke} strokeWidth="1.2" fill="none" /></marker>;
              default:
                return null;
            }
          }),
        )}
      </defs>
    </svg>
  );
}
