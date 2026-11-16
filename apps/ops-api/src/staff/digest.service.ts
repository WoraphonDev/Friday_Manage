import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gte, inArray, like, lt } from 'drizzle-orm';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { staffAudit } from '../audit.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { Mailer } from '../mail.js';

const s = schema;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** ส่งสรุปตั้งแต่ 08:00 เวลาไทย (H2) */
export const DIGEST_HOUR = 8;

/** ชื่อรายการในอีเมล (ภาษาเดียวกับหน้าคำขออนุมัติ) */
const KIND_LABEL: Record<string, string> = {
  'workspace.discount': 'ส่วนลด',
  'workspace.coupon': 'ให้คูปอง',
  'workspace.extend_trial': 'ขยายทดลองใช้',
  'workspace.suspend': 'ระงับ Workspace',
  'workspace.transfer_owner': 'โอนความเป็นเจ้าของ',
  'billing.refund': 'คืนเงิน',
  'billing.credit': 'ให้เครดิต',
  'system.maintenance': 'ปิดปรับปรุง',
  'entitlements.version': 'บันทึกสิทธิ์เป็นเวอร์ชันใหม่',
  'entitlements.override': 'ปรับสิทธิ์เฉพาะราย',
  'promotions.plan_price': 'เปลี่ยนราคาแพ็กเกจ',
  'promotions.coupon_activate': 'เปิดใช้คูปอง',
  'restore.extend_purge': 'ยืดเวลาก่อนลบถาวร',
  'restore.workspace': 'กู้คืน Workspace แทนลูกค้า',
  'privacy.release_hold': 'ยกเลิก Legal hold',
  'privacy.retention_shorten': 'ลดระยะเก็บข้อมูล',
};

/** วันที่ไทย (YYYY-MM-DD) และจุดเริ่มของวันนั้นเป็นเวลา UTC */
const bkkDate = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);
const startOf = (iso: string) => new Date(Date.parse(`${iso}T00:00:00+07:00`));
const thaiDay = (iso: string) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(startOf(iso));
const hhmm = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(11, 16);
const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** f•••@mail.example */
export const maskEmail = (e: string | null | undefined) => {
  if (!e) return null;
  const [user, domain] = e.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
};

/**
 * สรุปรายการที่ Owner อนุมัติตัวเองของเมื่อวาน (H1–H3 · 06-ops-roles ข้อ 4)
 * - นับจาก approval_requests ที่ self_approved (1 คำขอ = 1 บรรทัด) ไม่ใช่จาก Audit log ที่มีหลายแถวต่อเรื่อง
 * - ส่ง 08:00 ถึงอีเมลส่วนตัวที่ยืนยันแล้ว · ไม่มีรายการ = ไม่ส่ง · มี Owner ≥ 2 คน = หยุดส่ง (ไม่มีการอนุมัติตัวเองแล้ว)
 * - ส่งไม่สำเร็จ / ยังไม่ตั้งอีเมล: Audit "approval.digest_failed" และแถบแดงในหน้าพนักงาน · รอบหน้ารวมรายการที่ค้าง
 * - รันวันละครั้งต่อคน: staff_push_notices `selfdigest-try:<staff>:<วัน>` · ส่งสำเร็จ `selfdigest:<staff>:<วัน>` (ใช้หาช่วงที่ค้าง)
 */
@Injectable()
export class DigestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SelfApprovalDigest');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    // ตรวจทุก 10 นาที · ถึง 08:00 แล้วส่งของวันนี้ครั้งเดียว (marker กันซ้ำแม้ restart / หลาย instance)
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(String(e))), 10 * 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** จองการรันของวันนี้ · false = เคยจองแล้ว */
  private async claim(key: string) {
    const r = await this.db.insert(s.staffPushNotices).values({ key }).onConflictDoNothing().returning({ key: s.staffPushNotices.key });
    return r.length > 0;
  }

  async tick(now = new Date()) {
    const hour = new Date(now.getTime() + 7 * HOUR).getUTCHours();
    if (hour < DIGEST_HOUR) return { sent: 0, failed: 0, skipped: 'too_early' as const };
    const owners = await this.approvals.activeOwners();
    if (owners.length >= 2) return { sent: 0, failed: 0, skipped: 'multiple_owners' as const };
    const today = bkkDate(now);
    let sent = 0;
    let failed = 0;
    for (const o of owners) {
      if (!(await this.claim(`selfdigest-try:${o.id}:${today}`))) continue;
      const r = await this.sendFor(o.id, today);
      if (r === 'sent') sent++;
      else if (r === 'failed') failed++;
    }
    return { sent, failed, skipped: null };
  }

  /** ช่วงที่ต้องสรุป: ตั้งแต่ต้นวันของการส่งสำเร็จครั้งล่าสุด (รวมรายการที่ค้างจากรอบที่ส่งไม่ได้) ถึงต้นวันนี้ · ไม่เคยส่ง = เมื่อวาน */
  private async window(staffId: string, today: string) {
    const [last] = await this.db
      .select({ key: s.staffPushNotices.key })
      .from(s.staffPushNotices)
      .where(like(s.staffPushNotices.key, `selfdigest:${staffId}:%`))
      .orderBy(desc(s.staffPushNotices.key))
      .limit(1);
    const yesterday = bkkDate(new Date(startOf(today).getTime() - DAY));
    const from = last ? last.key.split(':')[2] : yesterday;
    return { from: startOf(from < today ? from : yesterday), to: startOf(today), fromDay: from < today ? from : yesterday };
  }

  /** ส่งสรุปของพนักงานหนึ่งคน · คืน none = ไม่มีรายการ (ไม่ส่ง) */
  async sendFor(staffId: string, today: string): Promise<'sent' | 'failed' | 'none'> {
    const [st] = await this.db.select().from(s.staffUsers).where(eq(s.staffUsers.id, staffId));
    if (!st) return 'none';
    const w = await this.window(staffId, today);
    const rows = await this.db
      .select({ r: s.approvalRequests, ws: s.workspaces.name })
      .from(s.approvalRequests)
      .leftJoin(s.workspaces, eq(s.workspaces.id, s.approvalRequests.workspaceId))
      .where(and(eq(s.approvalRequests.selfApproved, true), eq(s.approvalRequests.decidedBy, staffId), gte(s.approvalRequests.decidedAt, w.from), lt(s.approvalRequests.decidedAt, w.to)))
      .orderBy(s.approvalRequests.decidedAt);
    if (!rows.length) {
      // ไม่มีรายการ = ไม่ต้องส่ง · นับเป็นส่งสำเร็จของช่วงนี้ เพื่อไม่ให้รอบหน้าย้อนไปไกล
      await this.claim(`selfdigest:${staffId}:${today}`);
      return 'none';
    }
    const day = w.fromDay === bkkDate(new Date(w.to.getTime() - DAY)) ? thaiDay(w.fromDay) : `${thaiDay(w.fromDay)} – ${thaiDay(bkkDate(new Date(w.to.getTime() - DAY)))}`;
    if (!st.personalEmail || !st.personalEmailVerifiedAt) {
      await staffAudit(this.db, null, 'approval.digest_failed', `ส่งสรุปรายการที่อนุมัติตัวเอง (${rows.length} รายการ · ${day}) ถึง ${st.name} ไม่ได้: ยังไม่ตั้งอีเมลส่วนตัว`, { type: 'staff', id: st.id });
      return 'failed';
    }
    const lines = rows.map(({ r, ws }) => {
      const p = r.payload as Record<string, unknown>;
      const input = (p.input ?? {}) as Record<string, unknown>;
      const what = [KIND_LABEL[r.kind] ?? r.kind, typeof input.days === 'number' ? `${input.days} วัน` : null, typeof input.percent === 'number' ? `${input.percent}%${typeof input.months === 'number' ? ` ${input.months} รอบ` : ''}` : null, r.amountSatang ? baht(r.amountSatang) : null].filter(Boolean).join(' ');
      return { at: hhmm(r.decidedAt!), what, customer: ws ?? '—', rule: typeof p.rule === 'string' ? p.rule : '—' };
    });
    const subject = `[Friday Ops] รายการที่คุณอนุมัติเอง · ${day} (${rows.length} รายการ)`;
    const text = [
      `คุณ${st.name} · มีรายการที่คุณขอและอนุมัติเองในฐานะ Owner คนเดียว ${rows.length} รายการ`,
      '',
      'เวลา | รายการ | ลูกค้า | เกินวงเงิน',
      ...lines.map((l) => `${l.at} | ${l.what} | ${l.customer} | ${l.rule}`),
      '',
      `ดูใน Audit log: ${config.origin}/staff?tab=audit&selfApproved=true`,
      '',
      'ถ้ารายการใดไม่ใช่คุณทำ ให้ปิดบัญชีจาก "พนักงานและสิทธิ์" ทันที และติดต่อผู้ดูแลระบบ',
      'ส่งถึงอีเมลส่วนตัวทุกวัน 08:00 เฉพาะวันที่มีรายการ · หยุดส่งเองเมื่อมี Owner คนที่สอง',
    ].join('\n');
    try {
      await this.mail.send({ to: st.personalEmail, subject, text });
    } catch (e) {
      await staffAudit(this.db, null, 'approval.digest_failed', `ส่งสรุปรายการที่อนุมัติตัวเอง (${rows.length} รายการ · ${day}) ถึง ${maskEmail(st.personalEmail)} ไม่สำเร็จ: ${(e as Error).message}`.slice(0, 500), { type: 'staff', id: st.id });
      return 'failed';
    }
    await this.claim(`selfdigest:${staffId}:${today}`);
    await staffAudit(this.db, null, 'approval.digest_sent', `ส่งสรุปรายการที่อนุมัติตัวเอง ${rows.length} รายการ (${day}) ถึง ${maskEmail(st.personalEmail)}`, { type: 'staff', id: st.id });
    return 'sent';
  }

  /** สถานะสำหรับแถบในหน้าพนักงาน (H3): ส่งล่าสุด / ส่งไม่สำเร็จ / ยังไม่ตั้งอีเมล */
  async status(staffIds: string[]) {
    if (!staffIds.length) return new Map<string, { lastSentAt: Date | null; lastSentText: string | null; failedAt: Date | null; failedText: string | null }>();
    const rows = await this.db
      .select({ targetId: s.staffAuditLogs.targetId, action: s.staffAuditLogs.action, reason: s.staffAuditLogs.reason, at: s.staffAuditLogs.createdAt })
      .from(s.staffAuditLogs)
      .where(and(inArray(s.staffAuditLogs.action, ['approval.digest_sent', 'approval.digest_failed']), inArray(s.staffAuditLogs.targetId, staffIds)))
      .orderBy(desc(s.staffAuditLogs.createdAt))
      .limit(200);
    const out = new Map<string, { lastSentAt: Date | null; lastSentText: string | null; failedAt: Date | null; failedText: string | null }>();
    for (const id of staffIds) {
      const sent = rows.find((r) => r.targetId === id && r.action === 'approval.digest_sent');
      const fail = rows.find((r) => r.targetId === id && r.action === 'approval.digest_failed');
      // แถบแดงค้างจนกว่าจะส่งได้: ล้มหลังส่งสำเร็จครั้งล่าสุด
      const open = fail && (!sent || fail.at.getTime() > sent.at.getTime());
      out.set(id, { lastSentAt: sent?.at ?? null, lastSentText: sent?.reason ?? null, failedAt: open ? fail.at : null, failedText: open ? fail.reason : null });
    }
    return out;
  }

  /** จำนวนรายการในสรุปล่าสุด (อ่านจากข้อความ Audit "N รายการ") */
  static countOf(text: string | null) {
    const m = text ? /(\d+) รายการ/.exec(text) : null;
    return m ? Number(m[1]) : null;
  }
}

