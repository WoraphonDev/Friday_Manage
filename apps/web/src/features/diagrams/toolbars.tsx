"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical,
  ArrowDownToLine, ArrowUpToLine, Bold, Copy, Frame, Group, Hand, Keyboard, Link2, Lock, LockOpen, Map as MapIcon, MousePointer2, MoveUpRight, Grid3x3,
  Scaling, Search, Smile, StickyNote, Trash2, Type, AlignLeft, AlignCenter, AlignRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EdgeData } from "./edges";
import { COLORS, MARKERS, type Marker, type NodeColor, type NodeData } from "./types";
import type { AlignMode } from "./ops";
import styles from "./diagrams.module.css";

export type Tool = "select" | "pan" | "text" | "note" | "frame" | "line";

function Btn({ label, kbd, on, disabled, onClick, children, className }: { label: string; kbd?: string; on?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={cn(styles.tool, on && styles.toolOn, className)} aria-pressed={on} disabled={disabled} title={kbd ? `${label} (${kbd})` : label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** เมนูเล็กที่เปิดใต้ปุ่ม · ปิดเมื่อคลิกข้างนอกหรือกด Esc */
function Menu({ label, button, children, wide = false }: { label: string; button: ReactNode; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={styles.menuWrap} ref={ref}>
      <button type="button" className={styles.tool} aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        {button}
      </button>
      {open && <div className={cn(styles.toolMenu, wide && styles.toolMenuWide)} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function TopToolbar({
  tool, setTool, grid, setGrid, minimap, setMinimap, selectedCount, onAlign, onDistribute, onArrange, onSearch, onShortcuts,
}: {
  tool: Tool; setTool: (t: Tool) => void; grid: boolean; setGrid: (v: boolean) => void; minimap: boolean; setMinimap: (v: boolean) => void;
  selectedCount: number; onAlign: (m: AlignMode) => void; onDistribute: () => void; onArrange: (dir: "front" | "back") => void; onSearch: () => void; onShortcuts: () => void;
}) {
  const t = useTranslations("diagrams.tools");
  return (
    <div className={styles.topTools} role="toolbar" aria-label={t("title")}>
      <Btn label={t("select")} kbd="V" on={tool === "select"} onClick={() => setTool("select")}><MousePointer2 size={15} /><span>{t("select")}</span></Btn>
      <Btn label={t("pan")} kbd="H" on={tool === "pan"} onClick={() => setTool("pan")}><Hand size={15} /><span>{t("pan")}</span></Btn>
      <span className={styles.vsep} />
      <Btn label={t("text")} kbd="T" on={tool === "text"} onClick={() => setTool("text")}><Type size={15} /><span>{t("text")}</span></Btn>
      <Btn label={t("note")} kbd="N" on={tool === "note"} onClick={() => setTool("note")}><StickyNote size={15} /><span>{t("note")}</span></Btn>
      <Btn label={t("frame")} kbd="F" on={tool === "frame"} onClick={() => setTool("frame")}><Frame size={15} /><span>{t("frame")}</span></Btn>
      <Btn label={t("line")} kbd="L" on={tool === "line"} onClick={() => setTool("line")}><MoveUpRight size={15} /><span>{t("line")}</span></Btn>
      <span className={styles.vsep} />
      <Menu label={t("align")} button={<><AlignStartVertical size={15} /><span>{t("align")} ▾</span></>}>
        {(close) => (
          <>
            {selectedCount < 2 && <p className={styles.menuHint}>{t("alignHint")}</p>}
            {(["left", "center", "right", "top", "middle", "bottom"] as AlignMode[]).map((m) => (
              <button key={m} type="button" role="menuitem" disabled={selectedCount < 2} onClick={() => { onAlign(m); close(); }}>
                <AlignIcon mode={m} /> {t(`alignTo.${m}`)}
              </button>
            ))}
            <button type="button" role="menuitem" disabled={selectedCount < 3} onClick={() => { onDistribute(); close(); }}><AlignHorizontalSpaceAround size={14} /> {t("distribute")}</button>
          </>
        )}
      </Menu>
      <Menu label={t("arrange")} button={<><ArrowUpToLine size={15} /><span>{t("arrange")} ▾</span></>}>
        {(close) => (
          <>
            <button type="button" role="menuitem" disabled={!selectedCount} onClick={() => { onArrange("front"); close(); }}><ArrowUpToLine size={14} /> {t("front")}</button>
            <button type="button" role="menuitem" disabled={!selectedCount} onClick={() => { onArrange("back"); close(); }}><ArrowDownToLine size={14} /> {t("back")}</button>
          </>
        )}
      </Menu>
      <span className={styles.vsep} />
      <Btn label={t("grid")} on={grid} onClick={() => setGrid(!grid)}><Grid3x3 size={15} /><span>{t("grid")}</span></Btn>
      <Btn label={t("minimap")} on={minimap} onClick={() => setMinimap(!minimap)}><MapIcon size={15} /><span>{t("minimap")}</span></Btn>
      <span className={styles.spacer} />
      <Btn label={t("search")} kbd="Ctrl F" onClick={onSearch}><Search size={15} /><span>{t("search")}</span></Btn>
      <Btn label={t("shortcuts")} kbd="?" onClick={onShortcuts}><Keyboard size={15} /></Btn>
    </div>
  );
}

export function AlignIcon({ mode }: { mode: AlignMode }) {
  const p = { size: 14 };
  switch (mode) {
    case "left": return <AlignStartVertical {...p} />;
    case "center": return <AlignCenterVertical {...p} />;
    case "right": return <AlignEndVertical {...p} />;
    case "top": return <AlignStartHorizontal {...p} />;
    case "middle": return <AlignCenterHorizontal {...p} />;
    case "bottom": return <AlignEndHorizontal {...p} />;
  }
}

export function Swatches({ value, onChange, label, allowNone = false }: { value?: NodeColor; onChange: (c: NodeColor) => void; label: string; allowNone?: boolean }) {
  const t = useTranslations("diagrams.colors");
  return (
    <div className={styles.swatches} role="radiogroup" aria-label={label}>
      {COLORS.filter((c) => allowNone || c).map((c) => (
        <button key={c} type="button" role="radio" aria-checked={(value ?? "default") === c} aria-label={t(c)} title={t(c)} className={cn(styles.swatch, styles[`color_${c}`], (value ?? "default") === c && styles.swatchOn)} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** แถบลอยเหนือกล่องที่เลือก (ขั้น 2 ของ storyboard) */
export function NodeBar({ data, onPatch, onLink, onIcon, onDuplicate, onDelete }: { data: NodeData; onPatch: (d: Partial<NodeData>) => void; onLink: () => void; onIcon: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const t = useTranslations("diagrams.bar");
  const tc = useTranslations("diagrams.colors");
  return (
    <div className={styles.floatBar} role="toolbar" aria-label={t("node")}>
      <Menu label={t("fill")} button={<><i className={cn(styles.swatchMini, styles[`color_${data.color}`])} />{t("fill")} ▾</>}>
        {(close) => <div className={styles.menuPad}><Swatches label={t("fill")} value={data.color} onChange={(c) => { onPatch({ color: c }); close(); }} /></div>}
      </Menu>
      <Menu label={t("border")} wide button={<><i className={cn(styles.swatchMini, styles.swatchRing, data.stroke && styles[`stroke_${data.stroke}`])} />{t("border")} ▾</>}>
        {(close) => (
          <div className={styles.menuPad}>
            <Swatches label={t("borderColor")} value={data.stroke} onChange={(c) => onPatch({ stroke: c })} />
            <div className={styles.segRow}>
              {(["solid", "dashed", "dotted", "none"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={(data.strokeStyle ?? "solid") === s} className={cn(styles.seg, (data.strokeStyle ?? "solid") === s && styles.segOn)} onClick={() => { onPatch({ strokeStyle: s }); close(); }}>{t(`line.${s}`)}</button>
              ))}
            </div>
          </div>
        )}
      </Menu>
      <Menu label={t("fontSize")} button={<>Aa {data.fontSize ?? 13} ▾</>}>
        {(close) => (
          <>
            {[11, 13, 15, 18, 22, 28].map((n) => <button key={n} type="button" role="menuitem" onClick={() => { onPatch({ fontSize: n }); close(); }} style={{ fontSize: `${Math.min(n, 18)}px` }}>{n}</button>)}
          </>
        )}
      </Menu>
      <button type="button" className={cn(styles.tool, data.bold && styles.toolOn)} aria-pressed={!!data.bold} title={`${t("bold")} (Ctrl B)`} aria-label={t("bold")} onClick={() => onPatch({ bold: !data.bold })}><Bold size={14} /></button>
      <button
        type="button"
        className={styles.tool}
        title={t("align")}
        aria-label={t("align")}
        onClick={() => onPatch({ align: data.align === "left" ? "right" : data.align === "right" ? "center" : "left" })}
      >
        {data.align === "left" ? <AlignLeft size={14} /> : data.align === "right" ? <AlignRight size={14} /> : <AlignCenter size={14} />}
      </button>
      <span className={styles.vsep} />
      <button type="button" className={styles.tool} title={t("icon")} aria-label={t("icon")} onClick={onIcon}><Smile size={14} /><span>{t("icon")}</span></button>
      <button type="button" className={cn(styles.tool, styles.toolAccent)} title={t("link")} aria-label={t("link")} onClick={onLink}>
        <Link2 size={14} /><span>{t("linkCount", { n: data.issueIds.length })}</span>
      </button>
      <span className={styles.vsep} />
      <button type="button" className={styles.tool} title={`${t("duplicate")} (Ctrl D)`} aria-label={t("duplicate")} onClick={onDuplicate}><Copy size={14} /></button>
      <button type="button" className={cn(styles.tool, data.locked && styles.toolOn)} aria-pressed={!!data.locked} title={data.locked ? t("unlock") : t("lock")} aria-label={data.locked ? t("unlock") : t("lock")} onClick={() => onPatch({ locked: !data.locked })}>
        {data.locked ? <Lock size={14} /> : <LockOpen size={14} />}
      </button>
      <button type="button" className={styles.tool} title={`${t("delete")} (Delete)`} aria-label={t("delete")} onClick={onDelete}><Trash2 size={14} /></button>
      <span className={styles.srOnly}>{tc("default")}</span>
    </div>
  );
}

/** แถบลอยเมื่อเลือกหลายกล่อง (ขั้น 7) */
export function MultiBar({ count, onAlign, onDistribute, onSameSize, onGroup, onDuplicate, onDelete }: { count: number; onAlign: (m: AlignMode) => void; onDistribute: () => void; onSameSize: () => void; onGroup: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const t = useTranslations("diagrams.bar");
  const tt = useTranslations("diagrams.tools");
  return (
    <div className={styles.floatBar} role="toolbar" aria-label={t("multi", { n: count })}>
      <span className={styles.barCount}>{t("multi", { n: count })}</span>
      <span className={styles.vsep} />
      {(["left", "center", "right", "top", "middle", "bottom"] as AlignMode[]).map((m) => (
        <button key={m} type="button" className={styles.tool} title={tt(`alignTo.${m}`)} aria-label={tt(`alignTo.${m}`)} onClick={() => onAlign(m)}><AlignIcon mode={m} /></button>
      ))}
      <button type="button" className={styles.tool} title={tt("distribute")} aria-label={tt("distribute")} disabled={count < 3} onClick={onDistribute}><AlignHorizontalSpaceAround size={14} /></button>
      <button type="button" className={styles.tool} title={t("sameSize")} aria-label={t("sameSize")} onClick={onSameSize}><Scaling size={14} /></button>
      <span className={styles.vsep} />
      <button type="button" className={styles.tool} title={`${t("group")} (Ctrl G)`} aria-label={t("group")} onClick={onGroup}><Group size={14} /><span>{t("group")}</span></button>
      <button type="button" className={styles.tool} title={`${t("duplicate")} (Ctrl D)`} aria-label={t("duplicate")} onClick={onDuplicate}><Copy size={14} /></button>
      <button type="button" className={styles.tool} title={t("delete")} aria-label={t("delete")} onClick={onDelete}><Trash2 size={14} /></button>
    </div>
  );
}

const MARKER_GLYPH: Record<Marker, string> = { none: "—", arrow: "▶", open: "＞", circle: "○", diamond: "◆", one: "‖", many: "⋲", "zero-many": "○⋲", "one-many": "|⋲" };

/** แถบลอยเหนือเส้นที่เลือก (ขั้น 6) */
export function EdgeBar({ data, onPatch, onLabel, onDelete }: { data: EdgeData; onPatch: (d: Partial<EdgeData>) => void; onLabel: () => void; onDelete: () => void }) {
  const t = useTranslations("diagrams.edge");
  const tc = useTranslations("diagrams.colors");
  const path = data.bend ? "bend" : (data.path ?? "smoothstep");
  const markerMenu = (side: "markerStart" | "markerEnd", current: Marker) => (
    <Menu label={t(side)} button={<>{t(side)}: {MARKER_GLYPH[current]} ▾</>}>
      {(close) => (
        <>
          {MARKERS.map((m) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={current === m} onClick={() => { onPatch({ [side]: m, cardinality: undefined }); close(); }}>
              <span className={styles.markerGlyph}>{MARKER_GLYPH[m]}</span> {t(`markers.${m}`)}
            </button>
          ))}
        </>
      )}
    </Menu>
  );
  const start = data.markerStart ?? (data.cardinality ? (data.cardinality === "n-n" ? "many" : "one") : "none");
  const end = data.markerEnd ?? (data.cardinality ? (data.cardinality === "1-1" ? "one" : "many") : "arrow");
  return (
    <div className={styles.floatBar} role="toolbar" aria-label={t("title")}>
      {(["bezier", "straight", "smoothstep"] as const).map((p) => (
        <button key={p} type="button" className={cn(styles.tool, path === p && styles.toolOn)} aria-pressed={path === p} onClick={() => onPatch({ path: p, bend: undefined })}>{t(`path.${p}`)}</button>
      ))}
      <span className={styles.vsep} />
      {markerMenu("markerStart", start)}
      {markerMenu("markerEnd", end)}
      <Menu label={t("width")} button={<>━ {data.width ?? 1.5}px ▾</>}>
        {(close) => <>{[1, 1.5, 2, 3, 4].map((w) => <button key={w} type="button" role="menuitem" onClick={() => { onPatch({ width: w }); close(); }}>{w}px</button>)}</>}
      </Menu>
      <Menu label={t("color")} button={<><i className={cn(styles.swatchMini, styles[`edgeColor_${data.color ?? "default"}`])} />{t("color")} ▾</>}>
        {(close) => <div className={styles.menuPad}><Swatches label={t("color")} value={data.color} onChange={(c) => { onPatch({ color: c }); close(); }} /></div>}
      </Menu>
      <button type="button" className={cn(styles.tool, data.dashed && styles.toolOn)} aria-pressed={!!data.dashed} onClick={() => onPatch({ dashed: !data.dashed })}>{t("dashed")}</button>
      <button type="button" className={styles.tool} onClick={onLabel}><Type size={14} /><span>{t("label")}</span></button>
      <button type="button" className={styles.tool} title={t("delete")} aria-label={t("delete")} onClick={onDelete}><Trash2 size={14} /></button>
      <span className={styles.srOnly}>{tc("default")}</span>
    </div>
  );
}
