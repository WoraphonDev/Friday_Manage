import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { OPS_DB } from '../db.js';
import { AppError, parse } from '../errors.js';
import { FRESH_SECONDS } from '../presence/presence.module.js';
import { TicketsQuery, TicketsService } from './tickets.service.js';

/**
 * ทำกับ Ticket ทีละหลายเรื่อง (ช่วง 3) · เลือกเป็นรายการ (ids) หรือทั้งหมดตามตัวกรอง (filter) ไม่เกิน 1,000 เรื่อง
 * ข้อความถึงลูกค้า: ดูตัวอย่างก่อน + พิมพ์จำนวนเรื่องให้ตรงจึงส่ง (กันส่งผิดชุด) · งานที่ไม่ถึงลูกค้าหน้าเว็บหน่วง 10 วินาทีให้ย้อนได้
 * ทำทีละเรื่องผ่านเมธอดเดิมของ TicketsService (สิทธิ์ · audit · อีเมล เหมือนทำมือ) และข้ามเรื่องที่ไม่ควรแตะ
 */
export const BULK_MAX = 1000;
/** ลูกค้าเพิ่งตอบภายในกี่นาที = ข้ามการส่งข้อความ (อ่านข้อความใหม่ก่อน) */
export const JUST_REPLIED_MIN = 5;
const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
const Solve = { outcome: z.string().trim().min(3).max(500), cause: z.string().trim().min(3).max(200), sendCsat: z.boolean().default(true) };
export const BulkAction = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('reply'),
      /** ใส่ตัวแปร {ชื่อผู้แจ้ง} {ชื่อ Workspace} {เลข Ticket} ได้ · แทนค่าทีละเรื่อง */
      body: z.string().trim().min(1).max(10_000),
      internal: z.boolean().default(false),
      /** ส่งแล้วปิดเรื่องด้วย (สาเหตุเดียวกันทั้งชุด) */
      solve: z.object({ cause: Solve.cause, sendCsat: Solve.sendCsat }).strict().optional(),
    })
    .strict(),
  z.object({ type: z.literal('assign'), staffId: z.uuid() }).strict(),
  z.object({ type: z.literal('solve'), ...Solve }).strict(),
  z.object({ type: z.literal('priority'), priority: Priority }).strict(),
  z.object({ type: z.literal('incident'), incidentId: z.uuid().nullable() }).strict(),
]);
type Action = z.infer<typeof BulkAction>;
const Target = {
  ids: z.array(z.uuid()).min(1).max(BULK_MAX).optional(),
  /** ตัวกรองเดียวกับหน้ารายการ (ค่าใน URL) */
  filter: z.record(z.string().max(30), z.string().max(300)).optional(),
};
export const BulkPreviewBody = z
  .object({ ...Target, action: BulkAction })
  .strict()
  .refine((b) => !!b.ids !== !!b.filter, { message: 'เลือกเป็นรายการหรือตามตัวกรองอย่างใดอย่างหนึ่ง', path: ['ids'] });
export const BulkStartBody = z
  .object({ ...Target, action: BulkAction, confirmCount: z.number().int().min(0).optional() })
  .strict()
  .refine((b) => !!b.ids !== !!b.filter, { message: 'เลือกเป็นรายการหรือตามตัวกรองอย่างใดอย่างหนึ่ง', path: ['ids'] });

type Reason = 'closed' | 'solved' | 'typing' | 'just_replied' | 'no_change';
const REASONS: Record<Reason, string> = {
  closed: 'ปิดถาวรแล้ว',
  solved: 'แก้แล้ว',
  typing: 'มีคนกำลังพิมพ์ตอบ',
  just_replied: `ลูกค้าเพิ่งตอบภายใน ${JUST_REPLIED_MIN} นาที`,
  no_change: 'เป็นค่านี้อยู่แล้ว',
};
interface Item {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  requester: string;
  workspace: string;
  typingBy: string | null;
  justReplied: boolean;
  incidentId: string | null;
}
interface Skip {
  id: string;
  number: number;
  reason: Reason;
  message: string;
}
export interface BulkJob {
  id: string;
  staffId: string;
  action: Action['type'];
  total: number;
  done: number;
  ok: { id: string; number: number }[];
  skipped: Skip[];
  failed: { id: string; number: number; message: string }[];
  status: 'running' | 'done';
  startedAt: string;
  finishedAt: string | null;
}

/** ส่งถึงลูกค้า (อีเมล) = ต้องพิมพ์จำนวนยืนยัน และย้อนไม่ได้ */
export const customerFacing = (a: Action) => (a.type === 'reply' && !a.internal) || a.type === 'solve' || (a.type === 'reply' && !!a.solve);
export const fill = (body: string, x: Pick<Item, 'requester' | 'workspace' | 'number'>) => body.replaceAll('{ชื่อผู้แจ้ง}', x.requester).replaceAll('{ชื่อ Workspace}', x.workspace).replaceAll('{เลข Ticket}', `#${x.number}`);

@Injectable()
export class BulkTicketsService {
  private readonly log = new Logger('OpsBulkTickets');
  /** งานที่กำลังทำ / เพิ่งเสร็จ (เก็บในหน่วยความจำ 1 ชม. · ผลละเอียดอยู่ใน audit ของแต่ละเรื่องแล้ว) */
  private readonly jobs = new Map<string, BulkJob>();

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly tickets: TicketsService,
  ) {}

  private async rows<T>(q: ReturnType<typeof sql>) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  /** รหัส Ticket ของชุด · ตามตัวกรองใช้ list เดิม (ตัวกรองเดียวกับหน้าจอ) */
  private async targetIds(staff: Staff, b: { ids?: string[]; filter?: Record<string, string> }) {
    if (b.ids) return [...new Set(b.ids)];
    const { tab, page: _page, ...rest } = b.filter ?? {};
    void _page;
    const assignee = tab === 'mine' ? 'me' : tab === 'none' ? 'none' : undefined;
    const ids: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const q = parse(TicketsQuery, { ...rest, ...(assignee ? { assignee } : {}), limit: '200', offset: String(offset) });
      const r = await this.tickets.list(staff, q);
      ids.push(...r.items.map((x) => x.id as string));
      if (ids.length > BULK_MAX) throw new AppError(422, 'too_many', `ทำได้ครั้งละไม่เกิน ${BULK_MAX.toLocaleString('en-US')} เรื่อง · กรองให้แคบลงก่อน`, { max: BULK_MAX, total: r.total });
      if (r.items.length < 200) break;
    }
    return ids;
  }

  private async load(staff: Staff, ids: string[]) {
    if (!ids.length) return [];
    return this.rows<Item>(sql`
      select k.id, k.number, k.subject, k.status, k.priority, k.assignee_id as "assigneeId",
        coalesce(u.display_name, split_part(k.requester_email, '@', 1)) as requester, coalesce(w.name, '') as workspace,
        (select st.name from ops_presence p join staff_users st on st.id = p.staff_id
          where p.target_type = 'ticket' and p.target_id = k.id and p.mode = 'typing' and p.staff_id <> ${staff.id}
            and p.seen_at > now() - make_interval(secs => ${FRESH_SECONDS}) limit 1) as "typingBy",
        -- ข้อความแรกตอนเปิดเรื่องไม่นับ (เหตุขัดข้องมีเรื่องใหม่เข้ามาเยอะ ต้องตอบทีเดียวได้) · นับเฉพาะที่ลูกค้าตอบเพิ่มหลังจากนั้น
        exists(select 1 from support_ticket_messages m where m.ticket_id = k.id and m.author_kind = 'customer'
          and m.created_at > now() - make_interval(mins => ${JUST_REPLIED_MIN}) and m.created_at > k.created_at + interval '1 second'
          and m.created_at > coalesce((select max(x.created_at) from support_ticket_messages x where x.ticket_id = k.id and x.author_kind = 'staff'), '-infinity')) as "justReplied",
        (select ti.incident_id from support_ticket_incidents ti where ti.ticket_id = k.id) as "incidentId"
      from support_tickets k left join users u on u.id = k.requester_user_id left join workspaces w on w.id = k.workspace_id
      where k.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      order by k.number`);
  }

  /** เหตุที่ข้ามเรื่องนี้ (null = ทำได้) */
  private skipOf(a: Action, x: Item): Reason | null {
    if (x.status === 'closed') return 'closed';
    if ((a.type === 'solve' || (a.type === 'reply' && a.solve)) && x.status === 'solved') return 'solved';
    if (a.type !== 'incident' && x.typingBy) return 'typing';
    if (customerFacing(a) && x.justReplied) return 'just_replied';
    if (a.type === 'priority' && x.priority === a.priority) return 'no_change';
    if (a.type === 'assign' && x.assigneeId === a.staffId) return 'no_change';
    if (a.type === 'incident' && x.incidentId === a.incidentId) return 'no_change';
    return null;
  }
  private split(a: Action, items: Item[]) {
    const ok: Item[] = [];
    const skipped: Skip[] = [];
    for (const x of items) {
      const r = this.skipOf(a, x);
      if (r) skipped.push({ id: x.id, number: x.number, reason: r, message: r === 'typing' ? `${x.typingBy} กำลังพิมพ์ตอบ` : REASONS[r] });
      else ok.push(x);
    }
    return { ok, skipped };
  }

  /** ตัวอย่างก่อนทำ: จำนวนที่จะทำจริง · ที่ข้ามพร้อมเหตุผล · ข้อความของเรื่องแรกหลังแทนตัวแปร */
  async preview(staff: Staff, input: z.infer<typeof BulkPreviewBody>) {
    const items = await this.load(staff, await this.targetIds(staff, input));
    const { ok, skipped } = this.split(input.action, items);
    const a = input.action;
    const first = ok[0];
    return {
      total: items.length,
      eligible: ok.length,
      skipped,
      customerFacing: customerFacing(a),
      sample: a.type === 'reply' && first ? { number: first.number, subject: first.subject, body: fill(a.body, first) } : null,
    };
  }

  async start(staff: Staff, input: z.infer<typeof BulkStartBody>) {
    const ids = await this.targetIds(staff, input);
    const { ok, skipped } = this.split(input.action, await this.load(staff, ids));
    if (!ok.length) throw new AppError(422, 'nothing_to_do', 'ไม่มีเรื่องที่ทำได้ในชุดนี้', { skipped });
    // จำนวนที่พิมพ์ยืนยันต้องตรงกับที่จะส่งจริงตอนนี้ (มีเรื่องเปลี่ยนระหว่างดูตัวอย่าง = ให้ดูใหม่)
    if (customerFacing(input.action) && input.confirmCount !== ok.length) throw new AppError(409, 'count_mismatch', `จำนวนเรื่องที่จะส่งตอนนี้คือ ${ok.length} · ตรวจตัวอย่างอีกครั้ง`, { eligible: ok.length });
    const job: BulkJob = { id: randomUUID(), staffId: staff.id, action: input.action.type, total: ok.length, done: 0, ok: [], skipped, failed: [], status: 'running', startedAt: new Date().toISOString(), finishedAt: null };
    this.jobs.set(job.id, job);
    await staffAudit(this.db, staff, 'support.bulk', `ทำกับ Ticket ทีละหลายเรื่อง (${input.action.type}) ${ok.length} เรื่อง · ข้าม ${skipped.length}`, { type: 'support_bulk', id: job.id });
    void this.run(staff, input.action, ok, job);
    return this.view(job);
  }

  private async run(staff: Staff, a: Action, items: Item[], job: BulkJob) {
    for (const first of items) {
      try {
        // สถานะอาจเปลี่ยนระหว่างทำ (ลูกค้าตอบ / เพื่อนเริ่มพิมพ์) · ตรวจซ้ำก่อนแตะแต่ละเรื่อง
        const [x] = await this.load(staff, [first.id]);
        const r = x ? this.skipOf(a, x) : 'closed';
        if (!x || r) job.skipped.push({ id: first.id, number: first.number, reason: r ?? 'closed', message: r === 'typing' ? `${x?.typingBy} กำลังพิมพ์ตอบ` : REASONS[r ?? 'closed'] });
        else {
          await this.apply(staff, a, x);
          job.ok.push({ id: x.id, number: x.number });
        }
      } catch (e) {
        job.failed.push({ id: first.id, number: first.number, message: e instanceof AppError ? ((e.getResponse() as { message?: string }).message ?? 'ทำไม่สำเร็จ') : 'ทำไม่สำเร็จ' });
        if (!(e instanceof AppError)) this.log.error(String(e));
      }
      job.done++;
    }
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    setTimeout(() => this.jobs.delete(job.id), 3_600_000).unref();
  }

  private async apply(staff: Staff, a: Action, x: Item) {
    switch (a.type) {
      case 'reply':
        await this.tickets.message(staff, x.id, { body: fill(a.body, x), internal: a.internal, fromCustomer: false });
        if (a.solve) await this.tickets.solve(staff, x.id, { outcome: fill(a.body, x).slice(0, 500), cause: a.solve.cause, sendCsat: a.solve.sendCsat });
        return;
      case 'assign':
        return this.tickets.assign(staff, x.id, { staffId: a.staffId });
      case 'solve':
        return this.tickets.solve(staff, x.id, { outcome: fill(a.outcome, x), cause: a.cause, sendCsat: a.sendCsat });
      case 'priority':
        return this.tickets.setPriority(staff, x.id, { priority: a.priority });
      case 'incident':
        return this.tickets.linkIncident(staff, x.id, { incidentId: a.incidentId });
    }
  }

  private view(job: BulkJob) {
    const { staffId: _s, ...rest } = job;
    void _s;
    return rest;
  }
  /** ความคืบหน้า · ดูได้เฉพาะคนที่สั่ง */
  job(staff: Staff, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.staffId !== staff.id) throw new AppError(404, 'not_found', 'ไม่พบงานนี้ (ผลเก็บไว้ 1 ชั่วโมง)');
    return this.view(job);
  }
}
