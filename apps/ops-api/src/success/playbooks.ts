import { z } from 'zod';

/** ผลของงานโทร / ติดต่อ · ใช้เลือกทางแยกของขั้นถัดไป */
export const OUTCOMES = ['reached', 'no_answer', 'will_cancel'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const TRIGGERS = ['usage_drop', 'overdue', 'team_shrink', 'tickets_backlog', 'renewal_low_health'] as const;
export type TriggerKind = (typeof TRIGGERS)[number];
/** คะแนนสุขภาพถึงค่านี้ตอนครบขั้นรอ = ฟื้นแล้ว ปิด Playbook เอง (storyboard ขั้น 3) */
export const RECOVER_AT = 60;

const Branch = z.union([z.number().int().min(0).max(19), z.literal('close')]);
export const Step = z
  .object({
    kind: z.enum(['email', 'task', 'wait']),
    title: z.string().trim().min(2).max(120),
    /** อีเมลถึงลูกค้า (ขั้นอีเมล) */
    body: z.string().trim().max(2000).optional(),
    /** งานของคน = ทำให้เสร็จภายในกี่วัน · ขั้นรอ = รอกี่วัน */
    days: z.number().int().min(0).max(90).default(0),
    branches: z.object({ reached: Branch.optional(), no_answer: Branch.optional(), will_cancel: Branch.optional() }).strict().optional(),
  })
  .strict();
export type Step = z.infer<typeof Step>;
export const Trigger = z
  .object({
    kind: z.enum(TRIGGERS),
    /** usage_drop / team_shrink / tickets_backlog = ส่วนของคะแนนต่ำกว่า % นี้ · renewal_low_health = คะแนนรวมต่ำกว่านี้ · overdue = ไม่ใช้ */
    threshold: z.number().int().min(0).max(100),
    /** ต่ำกว่าเกณฑ์ติดกันกี่วัน */
    days: z.number().int().min(1).max(30),
  })
  .strict();
export type Trigger = z.infer<typeof Trigger>;
export const PlaybookBody = z
  .object({ name: z.string().trim().min(2).max(80), enabled: z.boolean(), trigger: Trigger, steps: z.array(Step).min(1).max(20) })
  .strict()
  .superRefine((v, ctx) => {
    v.steps.forEach((s, i) => {
      for (const [k, b] of Object.entries(s.branches ?? {})) {
        if (typeof b === 'number' && (b >= v.steps.length || b === i)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'branches', k], message: 'ขั้นปลายทางไม่ถูกต้อง' });
      }
      if (s.kind !== 'task' && s.branches) ctx.addIssue({ code: 'custom', path: ['steps', i, 'branches'], message: 'ทางแยกใช้ได้เฉพาะงานของคน' });
    });
  });

/** ส่วนของคะแนนที่แต่ละเงื่อนไขดู */
export const METRIC: Record<TriggerKind, 'usage' | 'payment' | 'growth' | 'support' | 'score'> = {
  usage_drop: 'usage',
  overdue: 'payment',
  team_shrink: 'growth',
  tickets_backlog: 'support',
  renewal_low_health: 'score',
};

/** Playbook ที่มีให้ตั้งแต่แรก (storyboard › รายละเอียด) · สร้างเมื่อยังไม่มีในฐานข้อมูล · แก้ได้จากปุ่มเฟือง */
export const DEFAULT_PLAYBOOKS: { key: TriggerKind; name: string; trigger: Trigger; steps: Step[] }[] = [
  {
    key: 'usage_drop',
    name: 'ใช้งานลดลง',
    trigger: { kind: 'usage_drop', threshold: 40, days: 3 },
    steps: [
      { kind: 'email', title: 'เคล็ดลับให้ทีมกลับมาใช้', body: 'ทีมของคุณใช้งาน Friday Work Management น้อยลงในช่วงนี้ · ลองตั้ง My Tasks ให้ทุกคนเห็นงานของวันนี้ และเปิดสรุปรายวันทาง LINE เพื่อให้ทีมไม่พลาดงาน · ถ้าติดตรงไหนตอบกลับอีเมลนี้ได้เลย', days: 0 },
      { kind: 'task', title: 'โทรหา Owner ถามว่าติดอะไร', days: 2, branches: { reached: 2, no_answer: 4, will_cancel: 3 } },
      { kind: 'task', title: 'นัดสอนใช้งาน 30 นาที', days: 5, branches: { reached: 4, no_answer: 4, will_cancel: 3 } },
      { kind: 'task', title: 'เสนอส่วนลด 1 เดือน (ขออนุมัติตามวงเงินเดิม)', days: 2, branches: { reached: 4, no_answer: 4, will_cancel: 'close' } },
      { kind: 'wait', title: 'รอ 14 วัน แล้วดูคะแนนอีกครั้ง', days: 14 },
    ],
  },
  {
    key: 'overdue',
    name: 'ค้างชำระ',
    trigger: { kind: 'overdue', threshold: 1, days: 1 },
    steps: [
      { kind: 'task', title: 'โทรตามใบแจ้งหนี้ที่ค้าง', days: 1, branches: { will_cancel: 'close' } },
      { kind: 'wait', title: 'รอ 7 วัน แล้วดูการชำระอีกครั้ง', days: 7 },
    ],
  },
  {
    key: 'team_shrink',
    name: 'ทีมหดตัว',
    trigger: { kind: 'team_shrink', threshold: 25, days: 3 },
    steps: [
      { kind: 'task', title: 'ถามเหตุผลที่ทีมลดลง และเสนอย้ายงานที่ค้าง', days: 3, branches: { will_cancel: 'close' } },
      { kind: 'wait', title: 'รอ 14 วัน แล้วดูคะแนนอีกครั้ง', days: 14 },
    ],
  },
  {
    key: 'tickets_backlog',
    name: 'Ticket ค้างเยอะ',
    trigger: { kind: 'tickets_backlog', threshold: 40, days: 2 },
    steps: [
      { kind: 'task', title: 'ทบทวน Ticket ที่ค้างกับหัวหน้า Support', days: 1 },
      { kind: 'wait', title: 'รอ 7 วัน แล้วดูคะแนนอีกครั้ง', days: 7 },
    ],
  },
  {
    key: 'renewal_low_health',
    name: 'ใกล้ต่อสัญญาแต่สุขภาพต่ำ',
    trigger: { kind: 'renewal_low_health', threshold: 50, days: 1 },
    steps: [
      { kind: 'task', title: 'วางแผนต่อสัญญากับคนดูแลบัญชี', days: 3, branches: { will_cancel: 'close' } },
      { kind: 'wait', title: 'รอ 14 วัน แล้วดูคะแนนอีกครั้ง', days: 14 },
    ],
  },
];
