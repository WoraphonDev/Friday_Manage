import { z } from 'zod';

/**
 * รูปแบบ content ของ Diagram (ตรงกับ node / edge ของ React Flow ที่หน้าเว็บส่งมา)
 * API ตรวจเข้มเพราะ JSON ก้อนนี้กลับไปแสดงให้ทุกคนในโปรเจกต์ · เก็บเฉพาะฟิลด์ที่รู้จัก ฟิลด์อื่นถูกตัดทิ้ง
 */
export const SHAPES = [
  // Flowchart (18)
  'terminator', 'process', 'decision', 'data', 'document', 'multi-document', 'subprocess', 'manual-input', 'manual-operation',
  'preparation', 'delay', 'merge', 'connector', 'off-page', 'stored-data', 'display', 'loop-limit', 'annotation',
  // Swimlane (3)
  'lane-h', 'lane-v', 'pool',
  // UML (8)
  'uml-class', 'uml-interface', 'uml-actor', 'uml-usecase', 'uml-component', 'uml-package', 'uml-lifeline', 'uml-state',
  // สถาปัตยกรรม (15)
  'actor', 'web-app', 'mobile-app', 'service', 'database', 'cache', 'queue', 'storage', 'server', 'load-balancer', 'cdn', 'cloud', 'external', 'firewall', 'group',
  // ER (3)
  'table', 'er-view', 'er-enum',
  // ไวท์บอร์ด (โน้ตหลายสีใช้ color · ลูกศรอิสระ = เส้นระหว่างจุด 'point' 2 จุด)
  'note', 'text', 'frame', 'rect', 'circle', 'triangle', 'point',
] as const;
export type Shape = (typeof SHAPES)[number];

/** ชื่อสีตาม token ของหน้าเว็บ (ไม่รับ hex ให้ทุกกล่องเปลี่ยนตามโหมดสว่าง / มืดได้) */
export const COLORS = ['default', 'purple', 'green', 'yellow', 'pink', 'gray', 'blue', 'orange'] as const;
/** ผูกงานได้สูงสุดต่อกล่อง (ผู้ใช้ตัดสิน 2026-11-19) */
export const MAX_ISSUES_PER_NODE = 20;
export const MARKERS = ['none', 'arrow', 'open', 'circle', 'diamond', 'one', 'many', 'zero-many', 'one-many'] as const;

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
  /** กรอบกลุ่ม / Frame / Lane อยู่ล่างสุด · ตัวเลขมากอยู่บน */
  zIndex: z.number().int().min(-1000).max(1000).optional(),
  data: z
    .object({
      label: z.string().max(500).default(''),
      color: z.enum(COLORS).default('default'),
      /** งานที่ผูก (ไม่บังคับ) · หลายงานต่อกล่อง */
      issueIds: z.array(z.uuid()).max(MAX_ISSUES_PER_NODE).optional(),
      /** รูปแบบเดิม (1 งานต่อกล่อง) · แปลงเป็น issueIds ให้เอง */
      issueId: z.uuid().nullish(),
      stroke: z.enum(COLORS).optional(),
      strokeStyle: z.enum(['solid', 'dashed', 'dotted', 'none']).optional(),
      fontSize: z.number().int().min(9).max(40).optional(),
      bold: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      /** ไอคอนจากชุดที่หน้าเว็บมี (ชื่อแบบ kebab-case) */
      icon: z.string().regex(/^[a-z0-9-]{1,40}$/).nullish(),
      locked: z.boolean().optional(),
      /** แถวคอลัมน์ของตาราง ER / ค่าของ Enum */
      columns: z.array(Column).max(80).optional(),
      /** ชื่อ Lane ของ Pool */
      lanes: z.array(z.string().max(60)).max(12).optional(),
      /** เนื้อหาหลายบรรทัด เช่น attribute / method ของ UML Class */
      body: z.string().max(2000).optional(),
    })
    .transform(({ issueId, issueIds, ...d }) => {
      const ids = [...new Set([...(issueIds ?? []), ...(issueId ? [issueId] : [])])].slice(0, MAX_ISSUES_PER_NODE);
      return { ...d, issueIds: ids };
    }),
});

const Edge = z.object({
  id: ElementId,
  source: ElementId,
  target: ElementId,
  sourceHandle: z.string().max(32).nullish(),
  targetHandle: z.string().max(32).nullish(),
  label: z.string().max(100).optional(),
  /** รูปแบบเดิมของ ER: 1–1, 1–∞, ∞–∞ (หน้าเว็บรุ่นใหม่ใช้หัวเส้นแบบตีนกาแทน) */
  cardinality: z.enum(['1-1', '1-n', 'n-n']).optional(),
  dashed: z.boolean().optional(),
  path: z.enum(['smoothstep', 'straight', 'bezier']).optional(),
  markerStart: z.enum(MARKERS).optional(),
  markerEnd: z.enum(MARKERS).optional(),
  width: z.number().min(1).max(6).optional(),
  color: z.enum(COLORS).optional(),
  /** จุดดัดเส้นที่ผู้ใช้ลากเอง */
  bend: z.object({ x: Coord, y: Coord }).optional(),
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
export const linkedIssueIds = (c: DiagramContent) => [...new Set(c.nodes.flatMap((n) => n.data.issueIds))];

/** ภาพย่อในการ์ดของหน้ารายการ: ตำแหน่งและรูปทรงพอให้วาดโครง ไม่ต้องส่ง JSON ทั้งก้อน */
export function previewOf(raw: unknown) {
  const parsed = Content.safeParse(raw);
  if (!parsed.success) return { nodes: [], edges: [] };
  const c = parsed.data;
  const nodes = c.nodes
    .filter((n) => n.type !== 'point')
    .slice(0, 80)
    .map((n) => ({ id: n.id, t: n.type, x: Math.round(n.position.x), y: Math.round(n.position.y), w: Math.round(n.width ?? defaultSize(n.type).w), h: Math.round(n.height ?? defaultSize(n.type).h), i: n.data.issueIds }));
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
    case 'merge':
      return { w: 56, h: 56 };
    case 'off-page':
      return { w: 56, h: 64 };
    case 'table':
    case 'er-view':
      return { w: 220, h: 140 };
    case 'er-enum':
      return { w: 160, h: 120 };
    case 'database':
    case 'stored-data':
      return { w: 120, h: 90 };
    case 'actor':
    case 'uml-actor':
      return { w: 90, h: 100 };
    case 'group':
    case 'frame':
      return { w: 360, h: 240 };
    case 'lane-h':
      return { w: 720, h: 160 };
    case 'lane-v':
      return { w: 220, h: 480 };
    case 'pool':
      return { w: 760, h: 360 };
    case 'note':
      return { w: 160, h: 120 };
    case 'text':
    case 'annotation':
      return { w: 160, h: 44 };
    case 'uml-class':
    case 'uml-interface':
      return { w: 200, h: 140 };
    case 'uml-usecase':
      return { w: 170, h: 70 };
    case 'uml-lifeline':
      return { w: 140, h: 320 };
    case 'uml-package':
      return { w: 200, h: 120 };
    case 'circle':
      return { w: 100, h: 100 };
    case 'triangle':
      return { w: 110, h: 100 };
    case 'rect':
      return { w: 140, h: 90 };
    case 'point':
      return { w: 12, h: 12 };
    case 'web-app':
    case 'mobile-app':
    case 'service':
    case 'cache':
    case 'storage':
    case 'server':
    case 'load-balancer':
    case 'cdn':
    case 'firewall':
      return { w: 130, h: 90 };
    case 'cloud':
      return { w: 160, h: 100 };
    default:
      return { w: 180, h: 60 };
  }
}

/** กล่องตัวอย่างตามแบบเริ่มต้น · ผู้ใช้ลบหรือแก้ต่อได้ทันที */
export function starterContent(template: 'blank' | 'flowchart' | 'er' | 'architecture' | 'whiteboard'): DiagramContent {
  const node = (id: string, type: Shape, x: number, y: number, label: string, extra: Partial<DiagramContent['nodes'][number]['data']> = {}): DiagramContent['nodes'][number] => ({
    id,
    type,
    position: { x, y },
    data: { label, color: 'default' as const, issueIds: [] as string[], ...extra },
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
