import { type Db, schema } from '@friday/db';
import { asc, eq, sql } from 'drizzle-orm';

// กฎการแจกงานและ SLA ของ Support (O22) สำหรับ Ticket ที่ลูกค้าเปิดจากในแอป
// ต้นฉบับอยู่ที่ apps/ops-api/src/support/{settings.service,clock}.ts · ops-api เป็นแอปแยกที่ API ลูกค้า import ไม่ได้
// จึงคัดเฉพาะส่วนที่ใช้ตอนสร้าง Ticket มาไว้ที่นี่ · แก้กติกาฝั่งใดต้องแก้อีกฝั่งให้ตรงกัน (test ของทั้งสองฝั่งตรวจค่าเริ่มต้นเดียวกัน)

const DAY = 86_400_000;
const OFF = 7 * 3_600_000;
const MIN = 60_000;
const s = schema;

export interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
export interface Dur {
  n: number;
  unit: 'h' | 'd';
}
type PlanSla = { first: Dur | null; resolve: Dur | null };
export interface SupportConfig {
  mode: 'least' | 'round' | 'manual';
  defaultCap: number;
  skipUnavailable: boolean;
  reopenDays: number;
  sla: Record<string, PlanSla>;
  hours: DayHours[];
  thaiHolidays: boolean;
}

const DEFAULT_HOURS: DayHours[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ open: i < 5, from: '09:00', to: '18:00' }));
export const DEFAULT_CONFIG: SupportConfig = {
  mode: 'least',
  defaultCap: 8,
  skipUnavailable: true,
  reopenDays: 7,
  sla: {
    free: { first: { n: 2, unit: 'd' }, resolve: null },
    team_s: { first: { n: 4, unit: 'h' }, resolve: { n: 3, unit: 'd' } },
    team_m: { first: { n: 4, unit: 'h' }, resolve: { n: 3, unit: 'd' } },
    team_l: { first: { n: 2, unit: 'h' }, resolve: { n: 2, unit: 'd' } },
    enterprise: { first: { n: 1, unit: 'h' }, resolve: { n: 1, unit: 'd' } },
  },
  hours: DEFAULT_HOURS,
  thaiHolidays: true,
};

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** เวลาทำการของทีม Support · เวลาไทย (UTC+7) */
export class BusinessClock {
  constructor(
    private readonly hours: DayHours[] = DEFAULT_HOURS,
    private readonly holidays: ReadonlySet<string> = new Set(),
  ) {}

  private dayStart(t: number) {
    return Math.floor((t + OFF) / DAY) * DAY - OFF;
  }
  private window(start: number): [number, number] | null {
    const local = new Date(start + OFF);
    const h = this.hours[(local.getUTCDay() + 6) % 7];
    if (!h?.open || this.holidays.has(local.toISOString().slice(0, 10))) return null;
    const w: [number, number] = [mins(h.from), mins(h.to)];
    return w[1] > w[0] ? w : null;
  }
  isOpen(at: Date) {
    const d = this.dayStart(at.getTime());
    const w = this.window(d);
    const m = (at.getTime() - d) / MIN;
    return !!w && m >= w[0] && m < w[1];
  }
  nextOpen(at: Date) {
    let d = this.dayStart(at.getTime());
    for (let i = 0; i < 400; i++, d += DAY) {
      const w = this.window(d);
      if (!w) continue;
      const t = Math.max(at.getTime(), d + w[0] * MIN);
      if (t < d + w[1] * MIN) return new Date(t);
    }
    return at;
  }
  addHours(start: Date, hours: number) {
    let left = Math.round(hours * 60);
    let t = start.getTime();
    for (let i = 0; i < 800; i++) {
      const d = this.dayStart(t);
      const w = this.window(d);
      const cur = (t - d) / MIN;
      if (!w || cur >= w[1]) {
        t = d + DAY;
        continue;
      }
      const from = Math.max(cur, w[0]);
      const avail = w[1] - from;
      if (left <= avail) return new Date(d + (from + left) * MIN);
      left -= avail;
      t = d + DAY;
    }
    return new Date(t);
  }
  addDays(start: Date, n: number) {
    const st = this.nextOpen(start);
    const clock = (st.getTime() - this.dayStart(st.getTime())) / MIN;
    let d = this.dayStart(st.getTime());
    for (let left = n, i = 0; left > 0 && i < 800; i++) {
      d += DAY;
      if (this.window(d)) left--;
    }
    const w = this.window(d) ?? [clock, clock];
    return new Date(d + Math.min(Math.max(clock, w[0]), w[1]) * MIN);
  }
  add(start: Date, dur: Dur) {
    return dur.unit === 'd' ? this.addDays(start, dur.n) : this.addHours(start, dur.n);
  }
}

type Row = Record<string, unknown>;
const rowsOf = <T>(r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as T[];
const isDur = (d: unknown): d is Dur => !!d && typeof d === 'object' && Number.isInteger((d as Dur).n) && (d as Dur).n > 0 && ((d as Dur).unit === 'h' || (d as Dur).unit === 'd');

/** ค่าที่ใช้อยู่ = ค่าเริ่มต้นทับด้วยค่าที่ Owner บันทึก · ค่าที่บันทึกผิดรูปใช้ค่าเริ่มต้นแทน (ops-api ตรวจรูปด้วย zod ก่อนบันทึกแล้ว) */
export async function loadConfig(db: Db): Promise<SupportConfig> {
  const [r] = await db.select({ config: s.supportSettings.config }).from(s.supportSettings).where(eq(s.supportSettings.id, 1));
  const saved = (r?.config ?? {}) as Partial<SupportConfig>;
  const cfg: SupportConfig = { ...DEFAULT_CONFIG, ...saved, sla: { ...DEFAULT_CONFIG.sla, ...(saved.sla ?? {}) } };
  const ok =
    ['least', 'round', 'manual'].includes(cfg.mode) &&
    Array.isArray(cfg.hours) &&
    cfg.hours.length === 7 &&
    Number.isInteger(cfg.reopenDays) &&
    Object.values(cfg.sla).every((p) => (p.first === null || isDur(p.first)) && (p.resolve === null || isDur(p.resolve)));
  return ok ? cfg : DEFAULT_CONFIG;
}

async function holidays(db: Db) {
  const list = rowsOf<{ date: string }>(
    await db.execute(sql`select distinct h.date::text as date from holidays h join holiday_calendars c on c.id = h.calendar_id
      where c.workspace_id is null and h.date >= current_date - 30 and h.date <= current_date + 400`),
  );
  return new Set(list.map((h) => h.date));
}

/** กำหนดตอบครั้งแรก / ปิดเรื่อง · ด่วนนับ 24 ชม. ทุกวัน ตอบครั้งแรกไม่เกิน 1 ชม. (เหมือน O22) */
export async function dueOf(db: Db, cfg: SupportConfig, plan: string, priority: string, from: Date) {
  const sla = cfg.sla[plan] ?? cfg.sla.free;
  if (priority === 'urgent') {
    const h = (d: Dur | null) => (d ? d.n * (d.unit === 'd' ? 24 : 1) : null);
    const first = Math.min(h(sla.first) ?? 1, 1);
    const resolve = h(sla.resolve);
    return { first: new Date(from.getTime() + first * 3_600_000), resolve: resolve ? new Date(from.getTime() + resolve * 3_600_000) : null, sla, open: true };
  }
  const clock = new BusinessClock(cfg.hours, cfg.thaiHolidays ? await holidays(db) : new Set());
  return { first: sla.first ? clock.add(from, sla.first) : null, resolve: sla.resolve ? clock.add(from, sla.resolve) : null, sla, open: clock.isOpen(from) };
}

/**
 * หาคนรับ: กฎแรกที่ตรง (แพ็กเกจ + หมวด) → กลุ่ม + ความสำคัญ → เลือกคนตามวิธีแจก (O22)
 * กลุ่มที่ยังไม่มีสมาชิกใช้ทุกคนแทน · acct ไม่มีผู้ดูแลหรือไม่ว่าง = คิวกลาง
 */
export async function routeTicket(db: Db, cfg: SupportConfig, ctx: { plan: string; category: string | null; workspaceId: string; minPriority?: string }) {
  const rules = await db.select().from(s.supportRules).orderBy(asc(s.supportRules.position), asc(s.supportRules.createdAt));
  const rule = rules.find((r) => r.enabled && (!r.plans.length || r.plans.includes(ctx.plan)) && (!r.categories.length || (!!ctx.category && r.categories.includes(ctx.category))));
  const target = rule?.target ?? 'all';
  const order = ['low', 'normal', 'high', 'urgent'];
  const base = rule?.priority ?? 'normal';
  const priority = ctx.minPriority && order.indexOf(ctx.minPriority) > order.indexOf(base) ? ctx.minPriority : base;
  const out = { ruleId: rule?.id ?? null, target, priority, assigneeId: null as string | null };
  if (cfg.mode === 'manual') return out;
  const agents = rowsOf<{ staffId: string; name: string; groups: string[]; cap: number | null; presence: string; load: number }>(
    await db.execute(sql`
      select st.id as "staffId", st.name, coalesce(a.groups, '{}') as groups, a.cap, coalesce(a.presence, 'online') as presence,
        (select count(*)::int from support_tickets k where k.assignee_id = st.id and k.status in ('open', 'pending_customer', 'pending_dev')) as load
      from staff_users st left join support_agents a on a.staff_id = st.id
      where st.status = 'active' and 'support' = any(st.roles) and (st.expires_at is null or st.expires_at > now())
      order by st.name`),
  );
  const free = (a: (typeof agents)[number]) => a.load < (a.cap ?? cfg.defaultCap) && (!cfg.skipUnavailable || a.presence === 'online');
  let pool: typeof agents;
  if (target === 'acct') {
    const [m] = await db.select({ staffId: s.supportAccountManagers.staffId }).from(s.supportAccountManagers).where(eq(s.supportAccountManagers.workspaceId, ctx.workspaceId));
    pool = agents.filter((a) => a.staffId === m?.staffId);
  } else {
    const members = target === 'all' ? agents : agents.filter((a) => a.groups.includes(target));
    pool = members.length ? members : agents;
  }
  const candidates = pool.filter(free);
  if (!candidates.length) return out;
  if (cfg.mode === 'least') {
    out.assigneeId = [...candidates].sort((a, b) => a.load - b.load || a.name.localeCompare(b.name, 'th'))[0].staffId;
    return out;
  }
  return db.transaction(async (tx) => {
    const [row] = rowsOf<Row>(await tx.execute(sql`select round_robin_last from support_settings where id = 1 for update`));
    const sorted = [...candidates].sort((a, b) => a.staffId.localeCompare(b.staffId));
    const last = (row?.round_robin_last as string | null) ?? null;
    const next = sorted.find((a) => last !== null && a.staffId > last) ?? sorted[0];
    await tx.insert(s.supportSettings).values({ id: 1, roundRobinLast: next.staffId }).onConflictDoUpdate({ target: s.supportSettings.id, set: { roundRobinLast: next.staffId } });
    return { ...out, assigneeId: next.staffId };
  });
}
