// ข้อความแจ้งเตือนที่ส่งออกนอกแอป (N2) · โครงสร้างเดียวกันทุกช่องทาง แล้ว render ตามช่องทางอีกที

export interface Msg {
  event: string;
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

/** รายละเอียดที่ซ่อนในโหมดปลอดภัย */
function details(p: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (k: string, v: unknown) => {
    const s = typeof v === 'number' ? String(v) : str(v);
    if (s) rows.push([k, s]);
  };
  const from = nameOf(p.from);
  const to = nameOf(p.to);
  if (from || to) rows.push(['สถานะ', `${from ?? '—'} → ${to ?? '—'}`]);
  add('ครบกำหนด', p.planEnd);
  add('Severity', p.severity);
  add('Priority', p.priority);
  if (Array.isArray(p.fields) && p.fields.length) rows.push(['ฟิลด์ที่เปลี่ยน', p.fields.filter((f) => typeof f === 'string').join(', ')]);
  add('เหตุผล', p.reason);
  add('จำนวนงาน', p.count);
  add('Overdue', p.overdue);
  add('เสร็จใน 7 วัน', p.done);
  add('งานที่ยังเปิด', p.open);
  add('ครบกำหนดวันนี้', p.dueToday);
  add('รอ Review', p.inReview);
  return rows;
}

export function buildMessage(src: MsgSource, ctx: Ctx): Msg {
  const p = src.payload ?? {};
  const spec = HEADS[src.eventType];
  const who = str(p.actorName) ?? 'ระบบ';
  const issueKey = str(p.issueKey);
  const projectKey = src.projectKey ?? str(p.projectKey);
  const project = [src.projectName ?? str(p.projectName), projectKey].filter(Boolean)[0] ?? '';
  const base = `${ctx.webUrl}/work/${ctx.workspaceSlug}`;
  const url = issueKey && projectKey ? `${base}/p/${projectKey}/table?issue=${encodeURIComponent(issueKey)}` : projectKey ? `${base}/p/${projectKey}` : base;
  const title = [issueKey, str(p.issueTitle)].filter(Boolean).join(' ') || str(p.title) || project;
  const excerpt = str(p.excerpt);
  return {
    event: src.eventType,
    head: spec ? spec.head(p, who) : src.eventType,
    title,
    project,
    rows: ctx.safe ? [] : details(p),
    note: ctx.safe || !excerpt ? '' : excerpt,
    buttons: [{ label: src.eventType === 'due_request.created' ? 'ดูคำขอในแอป' : 'เปิดในแอป', url }],
    color: spec?.color ?? '#3D4550',
    url,
    safe: ctx.safe,
  };
}

/** Bug Critical ข้ามช่วงงดส่ง · Urgent ข้ามช่วงงดส่งส่วนตัว (Profile: "ยกเว้นงาน Urgent") */
export const isCritical = (p: Record<string, unknown>) => String(p.severity ?? '').toLowerCase() === 'critical';
export const isUrgent = (p: Record<string, unknown>) => String(p.priority ?? '').toLowerCase() === 'urgent';
