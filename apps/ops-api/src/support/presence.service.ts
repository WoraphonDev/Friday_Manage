import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config as appConfig } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { SupportSettingsService } from './settings.service.js';

const s = schema;
type Row = Record<string, unknown>;
export const PresenceBody = z.object({ presence: z.enum(s.SUPPORT_PRESENCE), note: z.string().trim().max(80).optional() }).strict();
export const TeamQuery = z.object({ seen: z.enum(['0', '1']).optional() });

/** ทำไมเปลี่ยนสถานะ (support_agents.presence_reason) */
export type PresenceReason = 'manual' | 'logout' | 'idle' | 'session';
const AWAY = new Set(['offline', 'leave']);
/** เรื่องที่แจกอัตโนมัติยังโชว์ในการ์ดคิวกลางอีกสักพัก ("แจกให้ มิว อัตโนมัติ 12:41") */
const RECENT_AUTO_MIN = 15;
const AUTO_ASSIGNED = 'support.ticket_auto_assigned';

/**
 * สถานะพนักงาน Support และการแจกเรื่องใหม่ (รอบ 4 · S3–S5)
 * - ออฟไลน์อัตโนมัติ: ออกจากระบบ · หมดเวลาเข้าระบบ · ไม่มีการใช้งาน N นาที (นับจาก last_seen_at ที่หน้า Support เรียก team ทุก 1 นาที)
 * - แจกเรื่องในคิวกลางใหม่ทุก 1 นาที และทันทีที่มีคนกลับมาออนไลน์ ด้วย route() เดิม
 * สูตรคืนเข้าคิวของเรื่องที่ลูกค้าตอบหลังปิดมีซ้ำที่ apps/api/src/help/routing.ts (แก้ฝั่งหนึ่งต้องแก้อีกฝั่ง)
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SupportPresence');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly settings: SupportSettingsService,
  ) {}

  onModuleInit() {
    // ตรวจไม่มีการใช้งาน + แจกคิวกลางใหม่ทุก 1 นาที (ทำซ้ำได้) · test เรียก tick() เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Row>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** จำนวนเรื่องที่คืนเข้าคิวตอนเปลี่ยนสถานะครั้งล่าสุด (อ่านจาก Audit ของการเปลี่ยนนั้น) */
  private async releasedCounts() {
    const r = await this.rows<{ staffId: string; n: number }>(sql`
      select distinct on (l.target_id) l.target_id as "staffId", coalesce(substring(l.reason from 'คืนงานเข้าคิว ([0-9]+) เรื่อง')::int, 0) as n
      from staff_audit_logs l where l.action in ('support.presence_changed', 'support.presence_auto') and l.target_type = 'staff_user'
        and l.created_at > now() - interval '2 days'
      order by l.target_id, l.created_at desc`);
    return new Map(r.map((x) => [x.staffId, x.n]));
  }

  /**
   * ทีมตอนนี้ + คิวกลาง (หน้า Support · S3) · `seen=1` = หน้าเปิดอยู่และผู้ใช้มองเห็น → นับเป็นการใช้งาน (last_seen_at)
   * แท็บที่ซ่อนอยู่ไม่ส่ง seen จึงถือว่าไม่มีการใช้งาน
   */
  async team(staff: Staff, seen = false) {
    if (seen && staff.roles.includes('support')) {
      await this.db
        .insert(s.supportAgents)
        .values({ staffId: staff.id, lastSeenAt: new Date() })
        .onConflictDoUpdate({ target: s.supportAgents.staffId, set: { lastSeenAt: new Date() } });
    }
    const [cfg, agents, released] = await Promise.all([this.settings.config(), this.settings.agents(), this.releasedCounts()]);
    const items = agents.map(({ accounts: _a, email: _e, lastSeenAt: _l, ...a }) => ({ ...a, cap: a.cap ?? cfg.defaultCap, released: AWAY.has(a.presence) ? (released.get(a.staffId) ?? 0) : 0 }));
    const mine = items.find((a) => a.staffId === staff.id) ?? null;
    return {
      mode: cfg.mode,
      defaultCap: cfg.defaultCap,
      idleMinutes: cfg.idleOffline ? cfg.idleMinutes : null,
      items,
      me: mine ? { presence: mine.presence, presenceReason: mine.presenceReason, presenceAt: mine.presenceAt, presenceNote: mine.presenceNote, released: mine.released } : null,
      queue: await this.queue(cfg, items),
    };
  }

  /** คิวกลาง: เรื่องที่ยังไม่มีคนรับ + เรื่องที่เพิ่งแจกอัตโนมัติ · บอกเหตุที่ยังรออยู่ */
  private async queue(cfg: Awaited<ReturnType<SupportSettingsService['config']>>, agents: { presence: string; load: number; cap: number }[]) {
    const items = await this.rows<{ id: string; number: number; subject: string; priority: string; firstResponseDueAt: string | null; workspace: string | null; assigneeName: string | null; autoAt: string | null }>(sql`
      select k.id, k.number, k.subject, k.priority, k.first_response_due_at as "firstResponseDueAt", w.name as workspace, st.name as "assigneeName", auto.at as "autoAt"
      from support_tickets k left join workspaces w on w.id = k.workspace_id left join staff_users st on st.id = k.assignee_id
      left join lateral (select max(l.created_at) as at from staff_audit_logs l where l.action = ${AUTO_ASSIGNED} and l.target_id = k.id) auto on true
      where k.status = 'open' and (k.assignee_id is null or (auto.at > now() - make_interval(mins => ${RECENT_AUTO_MIN}) and k.assignee_id is not null))
      order by k.assignee_id is not null, (k.priority = 'urgent') desc, (k.priority = 'high') desc, coalesce(k.first_response_due_at, k.created_at)
      limit 10`);
    const online = agents.filter((a) => a.presence === 'online');
    const waiting = cfg.mode === 'manual' ? 'manual' : !online.length ? 'no_online' : online.every((a) => a.load >= a.cap) ? 'all_full' : null;
    return { items: items.map(({ assigneeName, autoAt, ...k }) => ({ ...k, autoAssigned: autoAt && assigneeName ? { name: assigneeName, at: autoAt } : null })), waiting, redispatch: cfg.redispatch };
  }

  /** เปลี่ยนสถานะของตัวเอง · ออฟไลน์/ลา ทำตามที่ตั้งไว้ · กลับมาออนไลน์ = แจกคิวกลางใหม่ทันที */
  async setPresence(staff: Staff, input: z.infer<typeof PresenceBody>) {
    const before = (await this.settings.agents()).find((a) => a.staffId === staff.id);
    if (!before) throw new AppError(403, 'not_support_agent', 'ตั้งสถานะได้เฉพาะพนักงาน Support');
    const r = await this.change({ staffId: staff.id, name: staff.name, presence: before.presence, load: before.load }, input.presence, input.note || null, 'manual', staff);
    const redispatched = input.presence === 'online' && before.presence !== 'online' ? (await this.redispatch()).assigned : 0;
    return { presence: input.presence, note: input.note || null, released: r.released, leadsNotified: r.leadsNotified, redispatched };
  }

  /**
   * เปลี่ยนสถานะ + ทำตามตั้งค่า "เรื่องที่ถืออยู่เมื่อออฟไลน์ / ลา" (คืนเข้าคิว / แจ้งหัวหน้าทีม / ถือไว้ต่อ)
   * staff = null คือระบบเปลี่ยนให้ (Audit ไม่มีผู้ทำ)
   */
  private async change(agent: { staffId: string; name: string; presence: string; load: number }, presence: string, note: string | null, reason: PresenceReason, staff: Staff | null) {
    const now = new Date();
    await this.db
      .insert(s.supportAgents)
      .values({ staffId: agent.staffId, presence, presenceNote: note, presenceAt: now, presenceReason: reason })
      .onConflictDoUpdate({ target: s.supportAgents.staffId, set: { presence, presenceNote: note, presenceAt: now, presenceReason: reason } });
    let released = 0;
    let leadsNotified = 0;
    if (AWAY.has(presence) && !AWAY.has(agent.presence) && agent.load > 0) {
      const cfg = await this.settings.config();
      if (cfg.onAway === 'queue') {
        // คืนเฉพาะเรื่องที่รอทีม Friday ตอบ · เรื่องที่รอลูกค้า/ทีมพัฒนายังอยู่กับคนเดิม
        const r = await this.db
          .update(s.supportTickets)
          .set({ assigneeId: null, updatedAt: now })
          .where(and(eq(s.supportTickets.assigneeId, agent.staffId), eq(s.supportTickets.status, 'open')))
          .returning({ id: s.supportTickets.id });
        released = r.length;
      } else if (cfg.onAway === 'ask_lead') {
        const word = presence === 'leave' ? 'ลา' : 'ออฟไลน์';
        leadsNotified = await this.settings.notifyLeads(`[Support] ${agent.name} ${word} · มีงานค้าง ${agent.load} เรื่อง`, `${agent.name} เปลี่ยนสถานะเป็น${word}${reason === 'manual' ? '' : 'อัตโนมัติ'} และยังมีงานค้าง ${agent.load} เรื่อง\nตรวจและโอนงานได้ที่หน้า Support`, agent.staffId);
      }
    }
    const why = reason === 'manual' ? '' : ` · อัตโนมัติ (${REASON_TEXT[reason]}${note && reason === 'idle' ? ` ${note}` : ''})`;
    await staffAudit(this.db, staff, reason === 'manual' ? 'support.presence_changed' : 'support.presence_auto', `${staff ? '' : `${agent.name}: `}สถานะ ${agent.presence} → ${presence}${reason === 'manual' && note ? ` · ${note}` : ''}${why}${released ? ` · คืนงานเข้าคิว ${released} เรื่อง` : ''}`, { type: 'staff_user', id: agent.staffId });
    return { released, leadsNotified };
  }

  /** ออกจากระบบ (auth.controller) → ออฟไลน์ ถ้าตั้งไว้ · คนที่ตั้ง "ลา" ไว้คงเดิม */
  async loggedOut(staff: Staff) {
    if (!staff.roles.includes('support')) return;
    const cfg = await this.settings.config();
    if (!cfg.offlineOnLogout) return;
    const a = (await this.settings.agents()).find((x) => x.staffId === staff.id);
    if (!a || AWAY.has(a.presence)) return;
    await this.change(a, 'offline', null, 'logout', null);
  }

  /** งานทุก 1 นาที: ออฟไลน์อัตโนมัติ แล้วแจกคิวกลางใหม่ */
  async tick(now = new Date()) {
    const offline = await this.autoOffline(now);
    const { assigned } = await this.redispatch();
    return { offline, assigned };
  }

  /**
   * ไม่มีการใช้งาน N นาที (นับจาก last_seen_at หรือเวลาที่ตั้งสถานะ) → ออฟไลน์ เหตุ idle
   * ปิดการตรวจไม่มีการใช้งาน แต่เปิด "หมดเวลาเข้าระบบ": ไม่เห็นเกิน 8 ชม. = cookie ที่ใช้ครั้งล่าสุดหมดอายุแน่นอน → เหตุ session
   * ไม่ว่าง / ลา: ไม่มีการใช้งานก็เปลี่ยนเป็นออฟไลน์เฉพาะ "ไม่ว่าง" · ลา ตั้งเองเท่านั้น
   */
  async autoOffline(now = new Date()) {
    const cfg = await this.settings.config();
    if (!cfg.idleOffline && !cfg.offlineOnLogout) return 0;
    const agents = await this.settings.agents();
    let n = 0;
    for (const a of agents) {
      if (a.presence !== 'online' && a.presence !== 'busy') continue;
      const last = a.lastSeenAt ?? a.presenceAt;
      const idleMs = last ? now.getTime() - new Date(last).getTime() : Infinity;
      let reason: PresenceReason | null = null;
      if (cfg.idleOffline && idleMs >= cfg.idleMinutes * 60_000) reason = 'idle';
      else if (cfg.offlineOnLogout && idleMs >= appConfig.sessionHours * 3_600_000) reason = 'session';
      if (!reason) continue;
      await this.change(a, 'offline', reason === 'idle' ? `ไม่มีการใช้งาน ${cfg.idleMinutes} นาที` : 'หมดเวลาเข้าระบบ', reason, null);
      n++;
    }
    return n;
  }

  /**
   * แจกเรื่องในคิวกลาง (ยังไม่มีคนรับ สถานะ open) ใหม่ตามวิธีแจกและกฎเดิม · ปิดในตั้งค่า / แจกเอง = ไม่ทำ
   * เขียนแบบมีเงื่อนไข assignee_id is null กันชนกับคนที่กด "รับเรื่องนี้" พร้อมกัน
   */
  async redispatch() {
    const cfg = await this.settings.config();
    if (!cfg.redispatch || cfg.mode === 'manual') return { assigned: 0 };
    const tickets = await this.rows<{ id: string; number: number; workspaceId: string | null; category: string | null; priority: string; plan: string | null }>(sql`
      select k.id, k.number, k.workspace_id as "workspaceId", k.category, k.priority, p.code as plan
      from support_tickets k left join subscriptions sub on sub.workspace_id = k.workspace_id left join plans p on p.id = sub.plan_id
      where k.status = 'open' and k.assignee_id is null
      order by (k.priority = 'urgent') desc, (k.priority = 'high') desc, coalesce(k.first_response_due_at, k.created_at)
      limit 100`);
    let assigned = 0;
    for (const k of tickets) {
      const route = await this.settings.route({ plan: k.plan ?? 'free', category: k.category, workspaceId: k.workspaceId, priority: k.priority });
      if (!route.assigneeId) continue;
      const done = await this.db.transaction(async (tx) => {
        const [r] = await tx.update(s.supportTickets).set({ assigneeId: route.assigneeId, updatedAt: new Date() }).where(and(eq(s.supportTickets.id, k.id), isNull(s.supportTickets.assigneeId))).returning({ id: s.supportTickets.id });
        if (!r) return false;
        const [to] = await tx.select({ name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, route.assigneeId!));
        // บันทึกภายในต้องเป็นข้อความฝั่งทีม (CHECK) · ไม่มีผู้เขียน = ระบบ
        await tx.insert(s.supportTicketMessages).values({ ticketId: k.id, authorKind: 'staff', internal: true, body: `แจกให้ ${to?.name ?? '—'} อัตโนมัติจากคิวกลาง` });
        await staffAudit(tx, null, AUTO_ASSIGNED, `#${k.number} · แจกให้ ${to?.name ?? '—'} อัตโนมัติจากคิวกลาง`, { type: 'support_ticket', id: k.id }, k.workspaceId ?? undefined);
        return true;
      });
      if (done) assigned++;
    }
    return { assigned };
  }

  /**
   * ลูกค้าตอบเรื่องที่ปิดแล้ว (เปิดใหม่) แต่คนเดิมออฟไลน์ / ลา → คืนเข้าคิวแล้วแจกใหม่ทันที (ตั้งค่า reopenToQueue)
   * คืน true ถ้าคืนเข้าคิว
   */
  async requeueIfAway(ticketId: string, assigneeId: string | null) {
    if (!assigneeId) return false;
    const cfg = await this.settings.config();
    if (!cfg.reopenToQueue) return false;
    const [a] = await this.db.select({ presence: s.supportAgents.presence, name: s.staffUsers.name }).from(s.staffUsers).leftJoin(s.supportAgents, eq(s.supportAgents.staffId, s.staffUsers.id)).where(eq(s.staffUsers.id, assigneeId));
    const presence = a?.presence ?? 'online';
    if (!AWAY.has(presence)) return false;
    await this.db.transaction(async (tx) => {
      await tx.update(s.supportTickets).set({ assigneeId: null, updatedAt: new Date() }).where(eq(s.supportTickets.id, ticketId));
      await tx.insert(s.supportTicketMessages).values({ ticketId, authorKind: 'staff', internal: true, body: `ลูกค้าตอบหลังปิดเรื่อง · ${a?.name ?? 'ผู้รับผิดชอบเดิม'} ${presence === 'leave' ? 'ลา' : 'ออฟไลน์'} จึงคืนเข้าคิวกลาง` });
    });
    await this.redispatch();
    return true;
  }
}

const REASON_TEXT: Record<Exclude<PresenceReason, 'manual'>, string> = { logout: 'ออกจากระบบ', idle: 'ไม่มีการใช้งาน', session: 'หมดเวลาเข้าระบบ' };
