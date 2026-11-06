import { z } from 'zod';

/** "เมื่อ … ถ้า … ให้ …" (หน้า P2) */
export const TRIGGERS = ['issue_created', 'status_changed', 'subtasks_done', 'overdue', 'test_attached', 'sprint_started', 'sprint_completed', 'schedule'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABELS: Record<Trigger, string> = {
  issue_created: 'งานถูกสร้าง',
  status_changed: 'สถานะงานเปลี่ยน',
  subtasks_done: 'Sub-task ทั้งหมดเสร็จ',
  overdue: 'งานเลย Due',
  test_attached: 'มีการแนบผลทดสอบ',
  sprint_started: 'Sprint เริ่ม',
  sprint_completed: 'Sprint ปิด',
  schedule: 'ตามเวลา',
};

const name = z.string().trim().min(1).max(80);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'เวลาต้องเป็น HH:MM');

/** ตัวกรองของ trigger (ไม่ใส่ = ทุกกรณี) */
export const TriggerConfigs = {
  issue_created: z.object({}).strict(),
  status_changed: z.object({ from: name.nullish(), to: name.nullish() }).strict(),
  subtasks_done: z.object({}).strict(),
  overdue: z.object({}).strict(),
  test_attached: z.object({}).strict(),
  sprint_started: z.object({}).strict(),
  sprint_completed: z.object({}).strict(),
  schedule: z.object({ frequency: z.enum(['daily', 'weekly']), time, weekday: z.number().int().min(1).max(7).optional() }).strict(),
} satisfies Record<Trigger, z.ZodType>;

export const CONDITION_FIELDS = ['type', 'status', 'statusCategory', 'priority', 'assignee', 'label', 'module', 'severity', 'estimateMd', 'daysToDue', 'isSubtask'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const Condition = z
  .object({
    field: z.enum(CONDITION_FIELDS),
    op: z.enum(['eq', 'in', 'gt', 'lt', 'empty', 'not_empty']).default('eq'),
    value: z.union([z.string().max(120), z.number(), z.boolean(), z.array(z.union([z.string().max(120), z.number()])).max(20)]).optional(),
    /** "ไม่ใช่" */
    not: z.boolean().default(false),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'empty' || c.op === 'not_empty') return;
    if (c.value === undefined) ctx.addIssue({ code: 'custom', message: 'ต้องระบุ value', path: ['value'] });
    if (c.op === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: 'op in ต้องเป็นรายการ', path: ['value'] });
    if ((c.op === 'gt' || c.op === 'lt') && typeof c.value !== 'number') ctx.addIssue({ code: 'custom', message: 'op gt/lt ต้องเป็นตัวเลข', path: ['value'] });
  });
export type Condition = z.infer<typeof Condition>;

const userRef = z.union([z.uuid(), z.enum(['reporter', 'creator'])]);
export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), status: name }).strict(),
  z.object({ type: z.literal('assign'), mode: z.enum(['add', 'set', 'clear']).default('add'), user: userRef.optional() }).strict(),
  z.object({ type: z.literal('set_priority'), priority: z.enum(['urgent', 'high', 'medium', 'low']) }).strict(),
  z.object({ type: z.literal('add_label'), label: name }).strict(),
  z.object({ type: z.literal('add_watcher'), user: userRef }).strict(),
  z.object({ type: z.literal('create_subtask'), title: z.string().trim().min(1).max(300), assignee: userRef.optional() }).strict(),
  z.object({ type: z.literal('comment'), body: z.string().trim().min(1).max(2000) }).strict(),
  z.object({
    type: z.literal('notify'),
    to: z.enum(['assignees', 'reporter', 'project_owner', 'users']),
    userIds: z.array(z.uuid()).max(20).optional(),
    message: z.string().trim().min(1).max(500),
  }).strict(),
]);
export type Action = z.infer<typeof Action>;

export const RuleBody = z
  .object({
    name,
    trigger: z.enum(TRIGGERS),
    triggerConfig: z.record(z.string(), z.unknown()).default({}),
    conditions: z.array(Condition).max(10).default([]),
    actions: z.array(Action).min(1).max(10),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((b, ctx) => {
    const r = (TriggerConfigs[b.trigger] as z.ZodType).safeParse(b.triggerConfig);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: ['triggerConfig', ...i.path] });
    const cfg = r.success ? (r.data as { frequency?: string; weekday?: number }) : null;
    if (b.trigger === 'schedule' && cfg?.frequency === 'weekly' && !cfg.weekday) ctx.addIssue({ code: 'custom', message: 'รายสัปดาห์ต้องระบุ weekday', path: ['triggerConfig', 'weekday'] });
  });
export const PatchRuleBody = z
  .object({
    name,
    trigger: z.enum(TRIGGERS),
    triggerConfig: z.record(z.string(), z.unknown()),
    conditions: z.array(Condition).max(10),
    actions: z.array(Action).min(1).max(10),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export const DryRunBody = z.object({ issueKey: z.string().trim().max(40).optional(), limit: z.number().int().min(1).max(200).default(50) });
export const RunsQuery = z.object({
  ruleId: z.uuid().optional(),
  result: z.enum(['success', 'skipped', 'failed', 'retried']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});

const DAYS = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const OPS: Record<string, string> = { eq: 'เป็น', in: 'เป็นหนึ่งใน', gt: 'มากกว่า', lt: 'น้อยกว่า', empty: 'ว่าง', not_empty: 'ไม่ว่าง' };
const COND_LABELS: Record<ConditionField, string> = { type: 'ประเภทงาน', status: 'สถานะ', statusCategory: 'หมวดสถานะ', priority: 'Priority', assignee: 'ผู้รับผิดชอบ', label: 'Label', module: 'Module', severity: 'Severity', estimateMd: 'Man-Day', daysToDue: 'วันถึง Due', isSubtask: 'เป็น Sub-task' };

export function describeTrigger(trigger: Trigger, cfg: Record<string, unknown>) {
  if (trigger === 'status_changed') {
    const [from, to] = [cfg.from, cfg.to];
    return `สถานะงานเปลี่ยน${from ? ` จาก ${from}` : ''}${to ? ` เป็น ${to}` : ''}`;
  }
  if (trigger === 'schedule') return `ทุก${cfg.frequency === 'weekly' ? `วัน${DAYS[Number(cfg.weekday)] ?? ''}` : 'วัน'} เวลา ${cfg.time}`;
  return TRIGGER_LABELS[trigger];
}
export const describeCondition = (c: Condition) => `${COND_LABELS[c.field]} ${c.not ? 'ไม่' : ''}${OPS[c.op]}${c.value === undefined ? '' : ` ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`}`;
export function describeAction(a: Action) {
  switch (a.type) {
    case 'set_status': return `เปลี่ยนสถานะเป็น ${a.status}`;
    case 'assign': return a.mode === 'clear' ? 'ล้างผู้รับผิดชอบ' : `${a.mode === 'set' ? 'ตั้งผู้รับผิดชอบเป็น' : 'เพิ่มผู้รับผิดชอบ'} ${a.user ?? '-'}`;
    case 'set_priority': return `ตั้ง Priority เป็น ${a.priority}`;
    case 'add_label': return `เพิ่ม Label ${a.label}`;
    case 'add_watcher': return `เพิ่ม Watcher ${a.user}`;
    case 'create_subtask': return `สร้าง Sub-task "${a.title}"`;
    case 'comment': return `เพิ่มคอมเมนต์ "${a.body.slice(0, 40)}"`;
    case 'notify': return `แจ้งเตือน ${a.to === 'users' ? 'ผู้ที่เลือก' : a.to === 'assignees' ? 'ผู้รับผิดชอบ' : a.to === 'reporter' ? 'ผู้แจ้ง' : 'เจ้าของโปรเจกต์'}: ${a.message.slice(0, 40)}`;
  }
}
export function sentence(r: { trigger: Trigger; triggerConfig: Record<string, unknown>; conditions: Condition[]; actions: Action[] }) {
  const cond = r.conditions.length ? ` ถ้า ${r.conditions.map(describeCondition).join(' และ ')}` : '';
  return `เมื่อ ${describeTrigger(r.trigger, r.triggerConfig)}${cond} ให้ ${r.actions.map(describeAction).join(' แล้ว ')}`;
}

/** แม่แบบสำเร็จรูป (หน้า P2 › ลองแม่แบบ) · ชื่อสถานะอ้างตาม Workflow มาตรฐาน */
export const TEMPLATES = [
  { id: 'review-notify', category: 'Workflow', name: 'ส่งต่อ Review', description: 'เมื่องานเข้า Review แจ้งผู้แจ้งงานทันที', rule: { name: 'งานเข้า Review → แจ้งผู้แจ้ง', trigger: 'status_changed', triggerConfig: { to: 'Review' }, conditions: [], actions: [{ type: 'notify', to: 'reporter', message: 'งานของคุณอยู่ระหว่าง Review' }] } },
  { id: 'done-comment', category: 'Workflow', name: 'ปิดงานแล้วบันทึก', description: 'เมื่องานเสร็จ เพิ่มคอมเมนต์สรุปอัตโนมัติ', rule: { name: 'งานเสร็จ → คอมเมนต์', trigger: 'status_changed', triggerConfig: { to: 'Done' }, conditions: [], actions: [{ type: 'comment', body: 'งานนี้เสร็จเรียบร้อยแล้ว' }] } },
  { id: 'parent-review', category: 'Workflow', name: 'Sub-task ครบ → Task เข้า Review', description: 'เมื่อ Sub-task ทั้งหมดเสร็จ ย้าย Task แม่ไป Review', rule: { name: 'Sub-task ครบ → Review', trigger: 'subtasks_done', triggerConfig: {}, conditions: [], actions: [{ type: 'set_status', status: 'Review' }] } },
  { id: 'bug-urgent', category: 'Bug', name: 'Bug Critical → Urgent', description: 'Bug ที่ Severity Critical ตั้ง Priority เป็น Urgent และแจ้งเจ้าของโปรเจกต์', rule: { name: 'Bug Critical → Urgent', trigger: 'issue_created', triggerConfig: {}, conditions: [{ field: 'severity', op: 'eq', value: 'critical', not: false }], actions: [{ type: 'set_priority', priority: 'urgent' }, { type: 'notify', to: 'project_owner', message: 'มี Bug Critical ใหม่' }] } },
  { id: 'overdue-nudge', category: 'ติดตาม', name: 'เตือนงานเลย Due', description: 'งานที่เลย Due แจ้งผู้รับผิดชอบและติด Label "เลยกำหนด"', rule: { name: 'งานเลย Due → เตือน', trigger: 'overdue', triggerConfig: {}, conditions: [], actions: [{ type: 'add_label', label: 'เลยกำหนด' }, { type: 'notify', to: 'assignees', message: 'งานของคุณเลยกำหนดแล้ว' }] } },
  { id: 'weekly-blocked', category: 'ติดตาม', name: 'สรุปงานค้างทุกวันจันทร์', description: 'ทุกวันจันทร์ 09:00 แจ้งเจ้าของโปรเจกต์ถึงงาน In progress ที่ไม่มีผู้รับผิดชอบ', rule: { name: 'จันทร์: งานไม่มีเจ้าของ', trigger: 'schedule', triggerConfig: { frequency: 'weekly', weekday: 1, time: '09:00' }, conditions: [{ field: 'statusCategory', op: 'eq', value: 'in_progress', not: false }, { field: 'assignee', op: 'empty', not: false }], actions: [{ type: 'notify', to: 'project_owner', message: 'มีงานที่กำลังทำแต่ไม่มีผู้รับผิดชอบ' }] } },
  { id: 'sprint-start', category: 'Sprint', name: 'Sprint เริ่ม → แจ้งผู้รับผิดชอบ', description: 'เมื่อ Sprint เริ่ม แจ้งทุกคนที่มีงานใน Sprint', rule: { name: 'Sprint เริ่ม → แจ้งทีม', trigger: 'sprint_started', triggerConfig: {}, conditions: [], actions: [{ type: 'notify', to: 'assignees', message: 'Sprint เริ่มแล้ว · งานนี้อยู่ใน Sprint' }] } },
  { id: 'test-failed', category: 'QA', name: 'ผลทดสอบไม่ผ่าน → ย้ายกลับ In progress', description: 'เมื่อแนบผลทดสอบที่ไม่ผ่าน ย้ายงานกลับ In progress และแจ้งผู้รับผิดชอบ', rule: { name: 'ทดสอบไม่ผ่าน → กลับไปแก้', trigger: 'test_attached', triggerConfig: {}, conditions: [], actions: [{ type: 'set_status', status: 'In progress' }, { type: 'notify', to: 'assignees', message: 'ผลทดสอบไม่ผ่าน กลับไปแก้ไข' }] } },
] as const;
