// ข้อความแจ้งเตือนที่ส่งออกนอกแอป (N2) · โครงสร้างเดียวกันทุกช่องทาง แล้ว render ตามช่องทางอีกที

export type Locale = 'th' | 'en';
/** ภาษาที่รองรับ · ค่าอื่นใช้ไทย */
export const toLocale = (v: unknown): Locale => (v === 'en' ? 'en' : 'th');

export interface Msg {
  event: string;
  /** ภาษาของข้อความ (ช่องทางส่วนตัวใช้ users.locale ของผู้รับ) */
  locale: Locale;
  head: string;
  title: string;
  project: string;
  rows: Array<[string, string]>;
  note: string;
  buttons: Array<{ label: string; url: string }>;
  color: string;
  url: string;
  /** โหมดปลอดภัย: ส่งเฉพาะหัวข้อ + ลิงก์ */
  safe: boolean;
}

export interface MsgSource {
  eventType: string;
  payload: Record<string, unknown>;
  projectKey?: string | null;
  projectName?: string | null;
}

interface Ctx {
  safe: boolean;
  webUrl: string;
  workspaceSlug: string;
  /** ไม่ส่ง = ไทย */
  locale?: Locale;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const nameOf = (v: unknown) => {
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') return (v as { name: string }).name;
  return str(v);
};

/** หัวข้อและสีของแต่ละเหตุการณ์ · ชื่อผู้ทำใส่ในหัวข้อเมื่อมี */
const HEADS: Record<string, { head: (p: Record<string, unknown>, who: string) => string; color: string }> = {
  'issue.assigned': { head: (p, who) => (p.removed ? `${who} ถอดคุณออกจากงาน` : `${who} มอบหมายงานให้คุณ`), color: '#1D4ED8' },
  'issue.review_requested': { head: (_p, who) => `${who} ขอให้คุณ Review`, color: '#1D4ED8' },
  'issue.mentioned': { head: (_p, who) => `${who} กล่าวถึงคุณในคอมเมนต์`, color: '#1D4ED8' },
  'issue.commented': { head: (_p, who) => `${who} คอมเมนต์ในงานที่คุณติดตาม`, color: '#3D4550' },
  'issue.status_changed': { head: (_p, who) => `${who} เปลี่ยนสถานะงาน`, color: '#3D4550' },
  'issue.updated': { head: (_p, who) => `${who} แก้ไขงานที่คุณติดตาม`, color: '#3D4550' },
  'issue.due_soon': { head: () => 'งานของคุณใกล้ครบกำหนด', color: '#B45309' },
  'issue.overdue': { head: () => 'งานเลยกำหนดแล้ว', color: '#B91C1C' },
  'bug.created': { head: (p) => `Bug ใหม่${str(p.severity) ? ` · ${p.severity}` : ''}`, color: '#DC2626' },
  'bug.reopened': { head: () => 'Bug ถูก Reopen', color: '#DC2626' },
  'test_run.failed': { head: () => 'ผลทดสอบไม่ผ่าน', color: '#DC2626' },
  'due_request.created': { head: (_p, who) => `${who} ขอเลื่อนวันครบกำหนด`, color: '#B45309' },
  'due_request.decided': { head: () => 'ผลการขอเลื่อนวันครบกำหนด', color: '#B45309' },
  'sprint.started': { head: () => 'Sprint เริ่มแล้ว', color: '#0F766E' },
  'sprint.completed': { head: () => 'Sprint จบแล้ว', color: '#0F766E' },
  'plan.changed': { head: (_p, who) => `${who} แก้ไขแผน`, color: '#B45309' },
  'project.health_changed': { head: () => 'Health ของโปรเจกต์เปลี่ยน', color: '#B45309' },
  'member.joined': { head: () => 'สมาชิกใหม่เข้าร่วมโปรเจกต์', color: '#15803D' },
  'member.invited': { head: () => 'มีการเชิญสมาชิกใหม่', color: '#15803D' },
  'import.completed': { head: () => 'นำเข้าไฟล์เสร็จแล้ว', color: '#15803D' },
  'digest.daily': { head: () => 'สรุปงานวันนี้', color: '#0F766E' },
  'report.weekly': { head: () => 'รายงานสรุปรายสัปดาห์', color: '#0F766E' },
  'channel.webhook_paused': { head: () => 'Webhook ถูกปิดชั่วคราว', color: '#B91C1C' },
};

/** หัวข้อภาษาอังกฤษ (W21) · เหตุการณ์ที่ไม่มีในนี้ใช้ชื่อเหตุการณ์ */
const HEADS_EN: Record<string, (p: Record<string, unknown>, who: string) => string> = {
  'issue.assigned': (p, who) => (p.removed ? `${who} removed you from a task` : `${who} assigned you a task`),
  'issue.review_requested': (_p, who) => `${who} asked you to review`,
  'issue.mentioned': (_p, who) => `${who} mentioned you in a comment`,
  'issue.commented': (_p, who) => `${who} commented on a task you watch`,
  'issue.status_changed': (_p, who) => `${who} changed a task status`,
  'issue.updated': (_p, who) => `${who} updated a task you watch`,
  'issue.due_soon': () => 'Your task is due soon',
  'issue.overdue': () => 'Task overdue',
  'bug.created': (p) => `New bug${str(p.severity) ? ` · ${p.severity}` : ''}`,
  'bug.reopened': () => 'Bug reopened',
  'test_run.failed': () => 'Test failed',
  'due_request.created': (_p, who) => `${who} asked to move a due date`,
  'due_request.decided': () => 'Due date request decided',
  'sprint.started': () => 'Sprint started',
  'sprint.completed': () => 'Sprint completed',
  'plan.changed': (_p, who) => `${who} changed the plan`,
  'project.health_changed': () => 'Project health changed',
  'member.joined': () => 'New member joined the project',
  'member.invited': () => 'New member invited',
  'import.completed': () => 'Import finished',
  'digest.daily': () => 'Your day at a glance',
  'report.weekly': () => 'Weekly summary report',
  'channel.webhook_paused': () => 'Webhook paused',
};

const LABELS = {
  th: { status: 'สถานะ', due: 'ครบกำหนด', fields: 'ฟิลด์ที่เปลี่ยน', reason: 'เหตุผล', count: 'จำนวนงาน', done: 'เสร็จใน 7 วัน', open: 'งานที่ยังเปิด', dueToday: 'ครบกำหนดวันนี้', inReview: 'รอ Review', system: 'ระบบ', openApp: 'เปิดในแอป', viewRequest: 'ดูคำขอในแอป' },
  en: { status: 'Status', due: 'Due', fields: 'Changed fields', reason: 'Reason', count: 'Tasks', done: 'Done in 7 days', open: 'Open tasks', dueToday: 'Due today', inReview: 'In review', system: 'System', openApp: 'Open in app', viewRequest: 'View request in app' },
} as const;
export const labelsOf = (locale: Locale) => LABELS[locale];

/** รายละเอียดที่ซ่อนในโหมดปลอดภัย */
function details(p: Record<string, unknown>, locale: Locale = 'th'): Array<[string, string]> {
  const L = LABELS[locale];
  const rows: Array<[string, string]> = [];
  const add = (k: string, v: unknown) => {
    const s = typeof v === 'number' ? String(v) : str(v);
    if (s) rows.push([k, s]);
  };
  const from = nameOf(p.from);
  const to = nameOf(p.to);
  if (from || to) rows.push([L.status, `${from ?? '—'} → ${to ?? '—'}`]);
  add(L.due, p.planEnd);
  add('Severity', p.severity);
  add('Priority', p.priority);
  if (Array.isArray(p.fields) && p.fields.length) rows.push([L.fields, p.fields.filter((f) => typeof f === 'string').join(', ')]);
  add(L.reason, p.reason);
  add(L.count, p.count);
  add('Overdue', p.overdue);
  add(L.done, p.done);
  add(L.open, p.open);
  add(L.dueToday, p.dueToday);
  add(L.inReview, p.inReview);
  return rows;
}

export function buildMessage(src: MsgSource, ctx: Ctx): Msg {
  const p = src.payload ?? {};
  const locale = ctx.locale ?? 'th';
  const L = LABELS[locale];
  const spec = HEADS[src.eventType];
  const who = str(p.actorName) ?? L.system;
  const issueKey = str(p.issueKey);
  const projectKey = src.projectKey ?? str(p.projectKey);
  const project = [src.projectName ?? str(p.projectName), projectKey].filter(Boolean)[0] ?? '';
  const base = `${ctx.webUrl}/work/${ctx.workspaceSlug}`;
  const url = issueKey && projectKey ? `${base}/p/${projectKey}/table?issue=${encodeURIComponent(issueKey)}` : projectKey ? `${base}/p/${projectKey}` : base;
  // สรุปงานเลยกำหนดไม่มีงานเดียว: ตั้งหัวเรื่องจากจำนวนตามภาษาของผู้รับ
  const summaryTitle =
    p.summary === true && typeof p.count === 'number'
      ? locale === 'en'
        ? `${p.count} overdue task${p.count === 1 ? '' : 's'}`
        : `งานเลยกำหนด ${p.count} งาน`
      : undefined;
  const title = [issueKey, str(p.issueTitle)].filter(Boolean).join(' ') || summaryTitle || str(p.title) || project;
  const excerpt = str(p.excerpt);
  const headEn = locale === 'en' ? HEADS_EN[src.eventType] : undefined;
  return {
    event: src.eventType,
    locale,
    head: headEn ? headEn(p, who) : spec ? spec.head(p, who) : src.eventType,
    title,
    project,
    rows: ctx.safe ? [] : details(p, locale),
    note: ctx.safe || !excerpt ? '' : excerpt,
    buttons: [{ label: src.eventType === 'due_request.created' ? L.viewRequest : L.openApp, url }],
    color: spec?.color ?? '#3D4550',
    url,
    safe: ctx.safe,
  };
}

/** Bug Critical ข้ามช่วงงดส่ง · Urgent ข้ามช่วงงดส่งส่วนตัว (Profile: "ยกเว้นงาน Urgent") */
export const isCritical = (p: Record<string, unknown>) => String(p.severity ?? '').toLowerCase() === 'critical';
export const isUrgent = (p: Record<string, unknown>) => String(p.priority ?? '').toLowerCase() === 'urgent';
