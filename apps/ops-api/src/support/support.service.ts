import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { has, type Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';

const s = schema;
export const StartSessionBody = z
  .object({
    ticketNo: z.string().trim().min(3).max(40).optional(),
    /** Ticket ในระบบ (O04) · ใส่แทน ticketNo ได้ */
    ticketId: z.uuid().optional(),
    reason: z.string().trim().min(10, 'ระบุเหตุผลอย่างน้อย 10 ตัวอักษร').max(500),
    mode: z.enum(['read', 'write']).default('read'),
    /** โหมดแก้ไข: ผู้อนุมัติคนที่ 2 (พนักงานอีกคน) */
    secondApproverId: z.uuid().optional(),
    /** ระยะเวลา (C1): 30 นาที / 1 ชม. / 2 ชม. · ไม่เกินวันหมดสิทธิ์ที่ลูกค้าให้ */
    durationMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]).default(60),
  })
  .strict()
  .refine((b) => b.ticketNo || b.ticketId, { message: 'ระบุ Ticket ที่ผูกกับการเข้าบัญชี', path: ['ticketId'] });

/** การเข้าบัญชีลูกค้าเพื่อช่วยเหลือ (Q3) · ต้องมี grant จากลูกค้า, Ticket, เหตุผล และผู้อนุมัติคนที่ 2 ในโหมดแก้ไข */
@Injectable()
export class SupportService {
  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
  ) {}

  async start(staff: Staff, workspaceId: string, input: z.infer<typeof StartSessionBody>) {
    if (!z.uuid().safeParse(workspaceId).success) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [ws] = await this.db.select().from(s.workspaces).where(and(eq(s.workspaces.id, workspaceId), isNull(s.workspaces.deletedAt)));
    if (!ws) throw new AppError(404, 'not_found', 'ไม่พบ Workspace');
    const [grant] = await this.db.select().from(s.supportAccessGrants).where(eq(s.supportAccessGrants.workspaceId, workspaceId));
    if (!grant || (grant.until && grant.until.getTime() < Date.now())) {
      throw new AppError(403, 'support_access_not_granted', 'ลูกค้ายังไม่ได้เปิดสิทธิ์ให้ทีม Friday เข้าช่วยเหลือ (หรือสิทธิ์หมดอายุแล้ว)');
    }
    if (input.mode === 'write' && grant.maxMode !== 'write') throw new AppError(403, 'support_mode_not_allowed', 'ลูกค้าอนุญาตเฉพาะโหมดอ่านอย่างเดียว', { maxMode: grant.maxMode });
    if (input.mode === 'write') {
      // คำตัดสิน 9 พ.ย. 2569 (ทางเลือก ข): ยังไม่เปิดโหมดแก้ไขจนกว่าจะมี Owner คนที่สอง
      if (await this.approvals.singleApprover()) throw new AppError(403, 'write_mode_disabled', 'โหมดแก้ไขยังไม่เปิด · ต้องมีผู้อนุมัติคนที่สองก่อน');
      if (!input.secondApproverId) throw new AppError(422, 'second_approver_required', 'โหมดแก้ไขต้องมีผู้อนุมัติคนที่ 2');
      if (input.secondApproverId === staff.id) throw new AppError(422, 'second_approver_must_differ', 'ผู้อนุมัติคนที่ 2 ต้องเป็นคนละคนกับผู้เข้า');
      const [approver] = await this.db.select({ id: s.staffUsers.id, roles: s.staffUsers.roles, status: s.staffUsers.status }).from(s.staffUsers).where(eq(s.staffUsers.id, input.secondApproverId));
      if (!approver || approver.status !== 'active' || !approver.roles.includes('owner')) throw new AppError(422, 'second_approver_invalid', 'ผู้อนุมัติคนที่ 2 ต้องเป็น Owner ที่ใช้งานอยู่');
    }
    // Ticket ในระบบต้องเป็นของ Workspace นี้และยังไม่ปิด
    let ticketNo = input.ticketNo ?? '';
    if (input.ticketId) {
      const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, input.ticketId));
      if (!t || t.workspaceId !== workspaceId) throw new AppError(422, 'ticket_other_workspace', 'Ticket นี้ไม่ใช่ของ Workspace นี้');
      if (t.status === 'solved' || t.status === 'closed') throw new AppError(422, 'ticket_not_open', 'Ticket นี้ปิดแล้ว');
      ticketNo = `#${t.number}`;
    }
    await this.closeExpired();
    const [open] = await this.db.select({ id: s.supportSessions.id }).from(s.supportSessions).where(and(eq(s.supportSessions.workspaceId, workspaceId), eq(s.supportSessions.staffId, staff.id), isNull(s.supportSessions.endedAt)));
    if (open) throw new AppError(409, 'session_already_open', 'คุณมี session ที่ยังเปิดอยู่กับ Workspace นี้', { sessionId: open.id });

    const duration = input.durationMinutes ?? 60;
    const expiresAt = new Date(Math.min(Date.now() + duration * 60_000, grant.until?.getTime() ?? Infinity));
    const session = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(s.supportSessions)
        .values({ workspaceId, staffId: staff.id, ticketNo, ticketId: input.ticketId ?? null, reason: input.reason, mode: input.mode, secondApproverId: input.mode === 'write' ? input.secondApproverId : null, expiresAt })
        .returning();
      await audit(tx, staff, workspaceId, 'secu', 'support.session_started', `เริ่มเข้าช่วยเหลือ · Ticket ${ticketNo} · ${input.mode === 'write' ? 'แก้ไขได้' : 'อ่านอย่างเดียว'} · ${duration} นาที · ${input.reason}`, { type: 'support_session', id: row.id });
      return row;
    });

    // แจ้ง Owner / Admin ทางอีเมลทันที (ถ้าลูกค้าเปิด "แจ้งเมื่อมีการเข้า") · ส่งไม่ได้ไม่ทำให้ session ล้ม
    let notified = 0;
    if (grant.notifyAdmins) {
      const admins = await this.db
        .select({ email: s.users.email })
        .from(s.workspaceMembers)
        .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
        .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.status, 'active'), sql`${s.workspaceMembers.role} in ('owner', 'admin')`));
      for (const a of admins) {
        try {
          await this.mail.send({
            to: a.email,
            subject: `ทีม Friday เข้าช่วยเหลือ Workspace ${ws.name} (Ticket ${ticketNo})`,
            text: `ทีม Friday (${staff.name}) เริ่มเข้าช่วยเหลือ Workspace ${ws.name}\nTicket: ${ticketNo}\nเหตุผล: ${input.reason}\nสิ้นสุดอัตโนมัติ: ${expiresAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' })}\nโหมด: ${input.mode === 'write' ? 'แก้ไขได้ (อนุมัติโดยพนักงาน 2 คน)' : 'อ่านอย่างเดียว'}\n\nดูประวัติได้ที่ ${config.appUrl}/work/${ws.slug}/admin · ปิดสิทธิ์ได้ทุกเมื่อที่ Admin Console › การเข้าช่วยเหลือจากทีม Friday`,
          });
          notified++;
        } catch {
          /* บันทึกใน mail log แล้ว */
        }
      }
    }
    return { session: this.dto(session), notified };
  }

  async end(staff: Staff, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ session');
    const [row] = await this.db.select().from(s.supportSessions).where(eq(s.supportSessions.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบ session');
    await this.closeExpired();
    if (row.endedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new AppError(409, 'session_ended', 'session นี้จบไปแล้ว');
    if (row.staffId !== staff.id && !has(staff, 'owner')) throw new AppError(403, 'forbidden', 'จบ session ของคนอื่นได้เฉพาะ Owner');
    const [ended] = await this.db.transaction(async (tx) => {
      const r = await tx.update(s.supportSessions).set({ endedAt: new Date() }).where(eq(s.supportSessions.id, id)).returning();
      await audit(tx, staff, row.workspaceId, 'secu', 'support.session_ended', `จบการเข้าช่วยเหลือ · Ticket ${row.ticketNo}`, { type: 'support_session', id });
      return r;
    });
    return { session: this.dto(ended) };
  }

  /**
   * session ที่เลยเวลาหมด → จบที่เวลาหมด (ไม่มีงานเบื้องหลังที่ต้องเปิด จึงปิดตอนมีคนอ่านหรือเริ่มใหม่)
   * บันทึกใน audit ของลูกค้าว่าจบเพราะหมดเวลา
   */
  async closeExpired() {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(s.supportSessions)
        .set({ endedAt: sql`${s.supportSessions.expiresAt}` })
        .where(and(isNull(s.supportSessions.endedAt), sql`${s.supportSessions.expiresAt} <= now()`))
        .returning();
      for (const r of rows)
        await tx.insert(s.auditLogs).values({ workspaceId: r.workspaceId, actorKind: 'system', category: 'secu', action: 'support.session_expired', targetType: 'support_session', targetId: r.id, summary: `การเข้าช่วยเหลือหมดเวลา · Ticket ${r.ticketNo}` });
    });
  }

  async open() {
    await this.closeExpired();
    const rows = await this.db
      .select({ s: s.supportSessions, workspace: s.workspaces.name, slug: s.workspaces.slug, staff: s.staffUsers.name })
      .from(s.supportSessions)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.supportSessions.workspaceId))
      .innerJoin(s.staffUsers, eq(s.staffUsers.id, s.supportSessions.staffId))
      .where(isNull(s.supportSessions.endedAt))
      .orderBy(desc(s.supportSessions.startedAt));
    return { items: rows.map((r) => ({ ...this.dto(r.s), workspace: { name: r.workspace, slug: r.slug }, staffName: r.staff })) };
  }

  private dto(r: typeof s.supportSessions.$inferSelect) {
    return { id: r.id, workspaceId: r.workspaceId, staffId: r.staffId, ticketNo: r.ticketNo, ticketId: r.ticketId, reason: r.reason, mode: r.mode, secondApproverId: r.secondApproverId, startedAt: r.startedAt, endedAt: r.endedAt, expiresAt: r.expiresAt };
  }
}
