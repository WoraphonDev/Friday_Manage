import { cn } from "@/lib/utils";
import type { DiagramSummary, PreviewNode } from "./types";
import styles from "./diagrams.module.css";

/** ภาพย่อในการ์ด: วาดโครงจากตำแหน่งกล่องที่ API ส่งมา (ไม่ต้องโหลด React Flow ทั้งตัวในหน้ารายการ) */
export function DiagramPreview({ preview }: { preview: DiagramSummary["preview"] }) {
  const nodes = preview.nodes;
  if (!nodes.length) return <svg className={styles.thumbSvg} viewBox="0 0 120 80" aria-hidden="true" />;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const pad = 12;
  const w = Math.max(maxX - minX, 1) + pad * 2;
  const h = Math.max(maxY - minY, 1) + pad * 2;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const center = (n: PreviewNode) => [n.x - minX + pad + n.w / 2, n.y - minY + pad + n.h / 2] as const;
  // กรอบกลุ่ม / Frame วาดก่อน กล่องอื่นทับด้านบน
  const ordered = [...nodes].sort((a, b) => Number(b.t === "group" || b.t === "frame") - Number(a.t === "group" || a.t === "frame"));
  return (
    <svg className={styles.thumbSvg} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {preview.edges.map(([a, b], i) => {
        const s = byId.get(a);
        const t = byId.get(b);
        if (!s || !t) return null;
        const [x1, y1] = center(s);
        const [x2, y2] = center(t);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={styles.thumbEdge} />;
      })}
      {ordered.map((n) => {
        const x = n.x - minX + pad;
        const y = n.y - minY + pad;
        const cls = cn(styles.thumbNode, n.s && styles[`thumb_${n.s}`], n.t === "note" && styles.thumbNote, (n.t === "group" || n.t === "frame") && styles.thumbGroup);
        if (n.t === "decision") return <polygon key={n.id} className={cls} points={`${x + n.w / 2},${y} ${x + n.w},${y + n.h / 2} ${x + n.w / 2},${y + n.h} ${x},${y + n.h / 2}`} />;
        if (n.t === "connector" || n.t === "database" || n.t === "actor") return <ellipse key={n.id} className={cls} cx={x + n.w / 2} cy={y + n.h / 2} rx={n.w / 2} ry={n.h / 2} />;
        if (n.t === "text") return null;
        return <rect key={n.id} className={cls} x={x} y={y} width={n.w} height={n.h} rx={n.t === "terminator" ? n.h / 2 : 6} />;
      })}
    </svg>
  );
}
