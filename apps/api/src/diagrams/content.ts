import { z } from 'zod';

/**
 * รูปแบบ content ของ Diagram (ตรงกับ node / edge ของ React Flow ที่หน้าเว็บส่งมา)
 * API ตรวจเข้มเพราะ JSON ก้อนนี้กลับไปแสดงให้ทุกคนในโปรเจกต์ · เก็บเฉพาะฟิลด์ที่รู้จัก ฟิลด์อื่นถูกตัดทิ้ง
 */
export const SHAPES = [
  // Flowchart
  'terminator',
  'process',
  'decision',
  'data',
  'document',
  'connector',
  // ER
  'table',
  // สถาปัตยกรรม
  'service',
  'database',
  'queue',
  'actor',
  'external',
  'group',
  // ไวท์บอร์ด
  'note',
  'text',
  'frame',
] as const;
export type Shape = (typeof SHAPES)[number];

/** ชื่อสีตาม token ของหน้าเว็บ (ไม่รับ hex ให้ทุกกล่องเปลี่ยนตามโหมดสว่าง / มืดได้) */
export const COLORS = ['default', 'purple', 'green', 'yellow', 'pink', 'gray'] as const;

export const MAX_NODES = 500;
export const MAX_EDGES = 1000;
export const MAX_CONTENT_BYTES = 1_000_000;

const Coord = z.number().finite().min(-1_000_000).max(1_000_000);
const Size = z.number().finite().min(8).max(20_000);
const ElementId = z.string().trim().min(1).max(64);

const Column = z.object({
  name: z.string().trim().max(80),
  type: z.string().trim().max(40).default(''),
  key: z.enum(['pk', 'fk']).nullable().default(null),
});

const Node = z.object({
  id: ElementId,
  type: z.enum(SHAPES),
  position: z.object({ x: Coord, y: Coord }),
  width: Size.optional(),
  height: Size.optional(),
  /** กรอบกลุ่ม / Frame อยู่ล่างสุด · ตัวเลขมากอยู่บน */
  zIndex: z.number().int().min(-1000).max(1000).optional(),
  data: z.object({
    label: z.string().max(500).default(''),
    color: z.enum(COLORS).default('default'),
    /** งานที่ผูก (ไม่บังคับ) · 1 งานต่อกล่อง */
    issueId: z.uuid().nullable().default(null),
    /** แถวคอลัมน์ของตาราง ER */
    columns: z.array(Column).max(80).optional(),
  }),
});

const Edge = z.object({
  id: ElementId,
  source: ElementId,
  target: ElementId,
  sourceHandle: z.string().max(32).nullish(),
  targetHandle: z.string().max(32).nullish(),
  label: z.string().max(100).optional(),
  /** ความสัมพันธ์ของ ER: 1–1, 1–∞, ∞–∞ */
  cardinality: z.enum(['1-1', '1-n', 'n-n']).optional(),
  /** เส้นประ เช่น ข้อมูลไหลแบบ async */
  dashed: z.boolean().optional(),
});

export const Content = z
  .object({
    nodes: z.array(Node).max(MAX_NODES),
    edges: z.array(Edge).max(MAX_EDGES),
    viewport: z.object({ x: Coord, y: Coord, zoom: z.number().finite().min(0.05).max(8) }).optional(),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const n of c.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `กล่อง ${n.id} ซ้ำ`, path: ['nodes'] });
      ids.add(n.id);
    }
    const edgeIds = new Set<string>();
    for (const e of c.edges) {
      if (edgeIds.has(e.id)) ctx.addIssue({ code: 'custom', message: `เส้น ${e.id} ซ้ำ`, path: ['edges'] });
      edgeIds.add(e.id);
      if (!ids.has(e.source) || !ids.has(e.target)) ctx.addIssue({ code: 'custom', message: `เส้น ${e.id} ต่อกับกล่องที่ไม่มีอยู่`, path: ['edges'] });
    }
  });
export type DiagramContent = z.infer<typeof Content>;

/** งานที่ผูกทั้งหมด (ไม่ซ้ำ) */
export const linkedIssueIds = (c: DiagramContent) => [...new Set(c.nodes.map((n) => n.data.issueId).filter((x): x is string => !!x))];

/** ภาพย่อในการ์ดของหน้ารายการ: ตำแหน่งและรูปทรงพอให้วาดโครง ไม่ต้องส่ง JSON ทั้งก้อน */
export function previewOf(raw: unknown) {
  const parsed = Content.safeParse(raw);
  if (!parsed.success) return { nodes: [], edges: [] };
  const c = parsed.data;
  const nodes = c.nodes.slice(0, 80).map((n) => ({ id: n.id, t: n.type, x: Math.round(n.position.x), y: Math.round(n.position.y), w: Math.round(n.width ?? defaultSize(n.type).w), h: Math.round(n.height ?? defaultSize(n.type).h), i: n.data.issueId }));
  const shown = new Set(nodes.map((n) => n.id));
  const edges = c.edges.filter((e) => shown.has(e.source) && shown.has(e.target)).slice(0, 120).map((e) => [e.source, e.target] as const);
  return { nodes, edges };
}

/** ขนาดเริ่มต้นของแต่ละรูปทรง · ต้องตรงกับหน้าเว็บ (features/diagrams/shapes.ts) */
export function defaultSize(type: Shape): { w: number; h: number } {
  switch (type) {
    case 'terminator':
      return { w: 160, h: 44 };
    case 'decision':
      return { w: 150, h: 90 };
    case 'connector':
      return { w: 48, h: 48 };
    case 'table':
      return { w: 220, h: 140 };
    case 'database':
      return { w: 120, h: 90 };
    case 'actor':
      return { w: 90, h: 90 };
    case 'group':
    case 'frame':
      return { w: 360, h: 240 };
    case 'note':
      return { w: 160, h: 120 };
    case 'text':
      return { w: 160, h: 40 };
    default:
      return { w: 180, h: 60 };
  }
}

/** กล่องตัวอย่างตามแบบเริ่มต้น · ผู้ใช้ลบหรือแก้ต่อได้ทันที */
export function starterContent(template: 'blank' | 'flowchart' | 'er' | 'architecture' | 'whiteboard'): DiagramContent {
  const node = (id: string, type: Shape, x: number, y: number, label: string, extra: Partial<DiagramContent['nodes'][number]['data']> = {}) => ({
    id,
    type,
    position: { x, y },
    data: { label, color: 'default' as const, issueId: null, ...extra },
  });
  switch (template) {
    case 'flowchart':
      return {
        nodes: [node('start', 'terminator', 10, 0, 'เริ่ม'), node('step', 'process', 0, 100, 'ขั้นตอนแรก'), node('end', 'terminator', 10, 220, 'จบ')],
        edges: [
          { id: 'e-start-step', source: 'start', target: 'step', sourceHandle: 'b', targetHandle: 't' },
          { id: 'e-step-end', source: 'step', target: 'end', sourceHandle: 'b', targetHandle: 't' },
        ],
      };
    case 'er':
      return {
        nodes: [
          node('t1', 'table', 0, 0, 'customer', { columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'name', type: 'text', key: null }] }),
          node('t2', 'table', 320, 0, 'order', { columns: [{ name: 'id', type: 'uuid', key: 'pk' }, { name: 'customer_id', type: 'uuid', key: 'fk' }] }),
        ],
        edges: [{ id: 'e-t1-t2', source: 't1', target: 't2', sourceHandle: 'r', targetHandle: 'l', cardinality: '1-n' }],
      };
    case 'architecture':
      return {
        nodes: [node('user', 'actor', 0, 10, 'ผู้ใช้'), node('web', 'service', 160, 25, 'Web'), node('db', 'database', 420, 10, 'Database')],
        edges: [
          { id: 'e-user-web', source: 'user', target: 'web', sourceHandle: 'r', targetHandle: 'l' },
          { id: 'e-web-db', source: 'web', target: 'db', sourceHandle: 'r', targetHandle: 'l' },
        ],
      };
    case 'whiteboard':
      return { nodes: [node('n1', 'note', 0, 0, 'ไอเดียแรก', { color: 'yellow' })], edges: [] };
    default:
      return { nodes: [], edges: [] };
  }
}
