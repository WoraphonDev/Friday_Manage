import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type BuyerSnapshot, type Db, schema } from '@friday/db';
import { salesReportData, salesTaxSummary } from '@friday/docs';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PushService } from '../push/push.service.js';
import { billingContacts, mailAll, todayBkk, vatRegistered } from './ledger.js';
import { WhtService } from './wht.service.js';

const s = schema;
type Row = Record<string, unknown>;
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');
/** ชนิดเอกสารในคิว e-Tax (path ของ API: tax-document · credit-note · debit-note) */
export const DocKind = z.enum(['tax_document', 'credit_note', 'debit_note']);
export type DocKind = z.infer<typeof DocKind>;
export const kindFromPath = (k: string): DocKind => {
  const r = DocKind.safeParse(k.replace(/-/g, '_'));
  if (!r.success) throw new AppError(404, 'not_found', 'ไม่พบชนิดเอกสาร');
  return r.data;
};
export const TaxQuery = z.object({ month: Month.optional() });
export const RetryETaxBody = z.object({ action: z.enum(['issue', 'cancel']).default('issue') }).strict();
/** E4 · ยกเลิกผ่านหน้าเว็บของผู้ให้บริการเองแล้ว */
export const ManualCancelBody = z.object({ reference: z.string().trim().min(3).max(80), reason: z.string().trim().min(3).max(500) }).strict();
export const RequestInfoBody = z.object({ message: z.string().trim().max(1000).optional() }).strict();

/** ลองส่งอัตโนมัติ 3 ครั้ง (ตรงกับ API ลูกค้า › ETAX_MAX_ATTEMPTS) */
export const ETAX_MAX_ATTEMPTS = 3;
const KIND_LABEL: Record<DocKind, string> = { tax_document: 'ใบกำกับภาษี/ใบเสร็จ', credit_note: 'ใบลดหนี้', debit_note: 'ใบเพิ่มหนี้' };

/**
 * แท็บ "ใบกำกับภาษี / 50 ทวิ" (รอบ 4 · E1–E4): การ์ดสรุป · เอกสาร e-Tax ที่ต้องดู (TX / CN / DN และการแจ้งยกเลิกในตารางเดียว)
 * รายงานภาษีขาย (สูตรเดียวกับ PDF / Excel ใน @friday/docs) · การส่งจริงทำโดยงานกวาดของ API ลูกค้า (คิว etax_jobs)
 */
@Injectable()
export class TaxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsTax');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly push: PushService,
    private readonly wht: WhtService,
  ) {}

  onModuleInit() {
    // งาน e-Tax ที่ล้มครบ 3 ครั้ง → แจ้งการเงินทุกชั่วโมง (ครั้งเดียวต่อการล้ม) · test เรียกเอง · ปิดด้วย OPS_JOBS=off
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.notifyFailures().catch((e) => this.log.error(`แจ้ง e-Tax ที่ล้มไม่สำเร็จ: ${String(e)}`)), 3_600_000);
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

  private async closedMonths() {
    const rows = await this.db.select({ month: s.staffAuditLogs.reason }).from(s.staffAuditLogs).where(eq(s.staffAuditLogs.action, 'billing.period_closed'));
    return new Set(rows.map((r) => r.month ?? ''));
  }

  /** สรุปภาษีขายของเดือน (ตัวเลขเดียวกับรายงาน PDF / Excel) */
  async sales(month: string) {
    const [y, m] = month.split('-').map(Number);
    const closed = (await this.closedMonths()).has(month);
    const data = await salesReportData(this.db, y, m, { closed });
    return { data, summary: salesTaxSummary(data.rows), closed };
  }

  // ---------------------------------------------------------------- E1

  async overview(q: z.infer<typeof TaxQuery>) {
    const month = q.month ?? todayBkk().slice(0, 7);
    const { data, summary, closed } = await this.sales(month);
    const year = month.slice(0, 4);
    const [whtYear] = await this.rows<{ total: number }>(sql`
      select coalesce(sum(wht_amount), 0)::float8 as total from invoices
      where status = 'paid' and wht_amount > 0 and to_char(paid_at at time zone 'Asia/Bangkok', 'YYYY') = ${year}`);
    const wht = await this.wht.list(month);
    const count = (k: string) => summary.lines.find((l) => l.kind === k)?.count ?? 0;
    return {
      month,
      closed,
      vatRegistered: vatRegistered(),
      kpi: {
        sales: { value: summary.net.value, vat: summary.net.vat, tx: count('tax_invoice'), rc: count('receipt'), dn: count('debit_note'), cn: count('credit_note') },
        etax: summary.etax,
        wht: wht.kpi,
        whtYear: { year: Number(year), satang: Number(whtYear?.total ?? 0) },
      },
      etax: await this.attention(),
      wht: { items: wht.items, counts: wht.counts },
      sales: { lines: summary.lines, net: summary.net, checks: data.checks, rows: data.rows.length },
    };
  }

  /**
   * เอกสาร e-Tax ที่ต้องดู: ล้ม (ครบ 3 ครั้ง หรือผู้ให้บริการปฏิเสธ) · กำลังลองใหม่หลังล้ม · แจ้งยกเลิกยังไม่สำเร็จ · ส่งแล้วรอผลเกิน 1 ชม.
   * ส่งสำเร็จแล้วไม่แสดง · ใบกำกับภาษีที่ล้มก่อนมีคิวก็แสดง (ไม่มีงานในคิว)
   */
  async attention() {
    const jobs = await this.rows<Row>(sql`
      select j.id, j.doc_kind as "docKind", j.doc_id as "docId", j.action, j.status, j.attempts, j.last_error as "lastError", j.last_attempt_at as "lastAttemptAt",
        j.next_attempt_at as "nextAttemptAt", j.updated_at as "updatedAt", j.provider_ref as "providerRef", j.note,
        coalesce(d.number, c.number, x.number) as number, d.doc_type as "docType", d.status as "docStatus",
        (select r.number from tax_documents r where r.replaces_id = j.doc_id limit 1) as replacement,
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace
      from etax_jobs j join workspaces w on w.id = j.workspace_id
        left join tax_documents d on j.doc_kind = 'tax_document' and d.id = j.doc_id
        left join credit_notes c on j.doc_kind = 'credit_note' and c.id = j.doc_id
        left join debit_notes x on j.doc_kind = 'debit_note' and x.id = j.doc_id
      where j.status = 'failed'
        or (j.status = 'pending' and j.attempts > 0 and j.last_error is not null)
        or (j.action = 'cancel' and j.status in ('pending', 'submitted') and j.created_at < now() - interval '10 minutes')
        or (j.status = 'submitted' and coalesce(j.last_attempt_at, j.updated_at) < now() - interval '1 hour')
      order by coalesce(j.last_attempt_at, j.updated_at) desc
      limit 200`);
    const legacy = await this.rows<Row>(sql`
      select d.id as "docId", d.number, d.doc_type as "docType", d.status as "docStatus", d.updated_at as "updatedAt", d.provider_ref as "providerRef",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace
      from tax_documents d join workspaces w on w.id = d.workspace_id
      where d.status = 'failed' and not exists (select 1 from etax_jobs j where j.doc_kind = 'tax_document' and j.doc_id = d.id and j.action = 'issue')
      order by d.updated_at desc limit 50`);
    const items = [
      ...jobs.map((j) => {
        const state = j.action === 'cancel' ? 'cancel_pending' : j.status === 'failed' ? 'failed' : j.status === 'submitted' ? 'waiting' : 'retrying';
        return {
          id: j.id as string, docKind: j.docKind as DocKind, docId: j.docId as string, number: j.number as string, docLabel: KIND_LABEL[j.docKind as DocKind], workspace: j.workspace,
          action: j.action as 'issue' | 'cancel', state, jobStatus: j.status as string, problem: (j.lastError as string | null) ?? null, attempts: Number(j.attempts), maxAttempts: ETAX_MAX_ATTEMPTS,
          nextAttemptAt: j.status === 'pending' ? j.nextAttemptAt : null, at: j.lastAttemptAt ?? j.updatedAt, submittedAt: j.status === 'submitted' ? (j.lastAttemptAt ?? j.updatedAt) : null,
          replacement: (j.replacement as string | null) ?? null, providerRef: (j.providerRef as string | null) ?? null,
        };
      }),
      ...legacy.map((d) => ({
        id: `doc:${d.docId}`, docKind: 'tax_document' as DocKind, docId: d.docId as string, number: d.number as string, docLabel: KIND_LABEL.tax_document, workspace: d.workspace,
        action: 'issue' as const, state: 'failed', jobStatus: 'failed', problem: null, attempts: 0, maxAttempts: ETAX_MAX_ATTEMPTS, nextAttemptAt: null, at: d.updatedAt, submittedAt: null, replacement: null, providerRef: (d.providerRef as string | null) ?? null,
      })),
    ];
    const counts = { all: items.length, failed: items.filter((i) => i.state === 'failed' || i.state === 'retrying').length, cancel: items.filter((i) => i.state === 'cancel_pending').length, waiting: items.filter((i) => i.state === 'waiting').length };
    return { items, counts };
  }

  /** ประวัติ e-Tax ทั้งเดือน: เอกสารภาษีทุกฉบับของเดือนพร้อมสถานะ e-Tax (ชุดเดียวกับรายงาน) */
  async history(q: z.infer<typeof TaxQuery>) {
    const month = q.month ?? todayBkk().slice(0, 7);
    const { data } = await this.sales(month);
    return { month, items: data.rows.map((r) => ({ date: r.date, number: r.number, kind: r.kind, cancelled: !!r.cancelled, note: r.note ?? null, buyerName: r.buyerName, value: r.value, vat: r.vat, etax: r.detail.etax, etaxState: r.detail.etaxState ?? 'not_required' })) };
  }

  // ---------------------------------------------------------------- E2 รายละเอียด

  private async doc(kind: DocKind, id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    const table = kind === 'tax_document' ? s.taxDocuments : kind === 'credit_note' ? s.creditNotes : s.debitNotes;
    const [row] = await this.db.select().from(table).where(eq(table.id, id));
    if (!row) throw new AppError(404, 'not_found', 'ไม่พบเอกสาร');
    return row as typeof s.taxDocuments.$inferSelect & Partial<typeof s.creditNotes.$inferSelect>;
  }

  async detail(kind: DocKind, id: string) {
    const d = await this.doc(kind, id);
    const [inv] = await this.db.select().from(s.invoices).where(eq(s.invoices.id, d.invoiceId));
    const [ws] = await this.db.select({ id: s.workspaces.id, slug: s.workspaces.slug, name: s.workspaces.name }).from(s.workspaces).where(eq(s.workspaces.id, d.workspaceId));
    const jobs = await this.db.select().from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, kind), eq(s.etaxJobs.docId, id)));
    const [profile] = await this.db.select().from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, d.workspaceId));
    const current: BuyerSnapshot | null = profile ? { companyName: profile.companyName, taxId: profile.taxId, branchType: profile.branchType, branchNo: profile.branchNo, address: profile.address, email: profile.taxEmail } : null;
    // ใบลด / เพิ่มหนี้: ผู้ซื้อ = ของใบกำกับภาษีที่อ้างถึง
    const [taxRef] = kind === 'tax_document' ? [] : await this.db.select().from(s.taxDocuments).where(and(eq(s.taxDocuments.invoiceId, d.invoiceId), sql`${s.taxDocuments.status} <> 'cancelled'`)).orderBy(desc(s.taxDocuments.createdAt)).limit(1);
    const buyer = ((kind === 'tax_document' ? d.buyer : taxRef?.buyer) as BuyerSnapshot | null) ?? current;
    const [replacement] = kind === 'tax_document' ? await this.db.select().from(s.taxDocuments).where(eq(s.taxDocuments.replacesId, id)).limit(1) : [];
    const [original] = kind === 'tax_document' && d.replacesId ? await this.db.select().from(s.taxDocuments).where(eq(s.taxDocuments.id, d.replacesId)) : [];
    const logs = await this.rows<{ at: string; action: string; summary: string | null; actorKind: string; staff: string | null }>(sql`
      select l.created_at as at, l.action, l.summary, l.actor_kind as "actorKind", st.name as staff
      from audit_logs l left join staff_users st on st.id = l.actor_id and l.actor_kind = 'friday_staff'
      where l.workspace_id = ${d.workspaceId} and (l.target_id = ${id} or (l.target_type = 'tax_document' and l.target_id = ${replacement?.id ?? id}) or (l.action = 'billing.payment_confirmed' and l.target_id = ${d.invoiceId}) or (l.action = 'ops.payment_confirmed' and l.target_id = ${d.invoiceId}))
      order by l.created_at`);
    const amount = kind === 'tax_document' ? { value: inv.subtotal, vat: inv.vat, total: inv.total } : { value: d.amountSatang!, vat: d.vatSatang!, total: d.amountSatang! + d.vatSatang! };
    const issue = jobs.find((j) => j.action === 'issue');
    const cancel = jobs.find((j) => j.action === 'cancel');
    const docStatus = kind === 'tax_document' ? d.status : (d.status ?? 'issued');
    return {
      kind, id, number: d.number, docLabel: KIND_LABEL[kind], docType: kind === 'tax_document' ? d.docType : kind,
      status: docStatus, cancelled: docStatus === 'cancelled', cancelReason: d.cancelReason ?? null, cancelledAt: d.cancelledAt ?? null,
      issuedOn: kind === 'tax_document' ? (d.issuedOn ?? null) : (d.issuedAt ?? d.createdAt).toISOString().slice(0, 10),
      providerRef: d.providerRef ?? issue?.providerRef ?? null,
      invoice: { id: inv.id, number: inv.number, status: inv.status, paidAt: inv.paidAt },
      workspace: ws, amount, buyer, currentBuyer: current,
      replacement: replacement ? { id: replacement.id, number: replacement.number, status: replacement.status, createdAt: replacement.createdAt } : null,
      replaces: original ? { id: original.id, number: original.number } : null,
      jobs: jobs.map((j) => ({ id: j.id, action: j.action, status: j.status, attempts: j.attempts, maxAttempts: ETAX_MAX_ATTEMPTS, lastError: j.lastError, lastAttemptAt: j.lastAttemptAt, nextAttemptAt: j.nextAttemptAt, providerRef: j.providerRef, note: j.note, createdAt: j.createdAt, updatedAt: j.updatedAt })),
      state: {
        issue: issue?.status ?? (kind === 'tax_document' ? (d.docType === 'receipt' ? 'not_required' : d.status) : 'not_required'),
        cancel: cancel?.status ?? null,
      },
      timeline: logs.map((l) => ({ at: l.at, action: l.action, summary: l.summary, by: l.actorKind === 'system' ? null : (l.staff ?? null), system: l.actorKind === 'system' })),
      pdf: `/${kind.replace(/_/g, '-')}s/${id}/pdf`,
    };
  }

  // ---------------------------------------------------------------- ปุ่มของการเงิน

  private async job(kind: DocKind, id: string, action: 'issue' | 'cancel') {
    const d = await this.doc(kind, id);
    const [job] = await this.db.select().from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, kind), eq(s.etaxJobs.docId, id), eq(s.etaxJobs.action, action)));
    return { d, job };
  }

  /** ส่งใหม่ / แจ้งอีกครั้ง: เริ่มนับ 3 ครั้งใหม่ · งานกวาดของ API ลูกค้าส่งภายใน 10 นาที */
  async retry(staff: Staff, kind: DocKind, id: string, action: 'issue' | 'cancel') {
    const { d, job } = await this.job(kind, id, action);
    if (!job) {
      // ใบกำกับภาษีที่ล้มก่อนมีคิว
      if (kind === 'tax_document' && action === 'issue' && d.status === 'failed') {
        await this.db.transaction(async (tx) => {
          await tx.update(s.taxDocuments).set({ status: 'pending', providerRef: null, updatedAt: new Date() }).where(eq(s.taxDocuments.id, id));
          await tx.insert(s.etaxJobs).values({ workspaceId: d.workspaceId, docKind: kind, docId: id, action, status: 'pending', nextAttemptAt: sql`now()`, byStaff: staff.id }).onConflictDoNothing();
          await audit(tx, staff, d.workspaceId, 'plan', 'ops.etax_retry', `ส่ง e-Tax ใหม่ ${d.number}`, { type: kind, id });
        });
        return { id, action, status: 'pending' as const };
      }
      throw new AppError(404, 'etax_job_not_found', 'เอกสารนี้ไม่มีงานส่ง e-Tax');
    }
    if (job.status !== 'failed' && !(job.status === 'pending' && job.attempts > 0 && job.lastError)) throw new AppError(409, 'not_failed', action === 'cancel' ? 'แจ้งอีกครั้งได้เฉพาะงานที่ยังไม่สำเร็จ' : 'ส่งใหม่ได้เฉพาะเอกสารที่ส่งไม่สำเร็จ', { status: job.status });
    if (action === 'issue' && kind === 'tax_document' && d.status === 'cancelled') throw new AppError(409, 'already_cancelled', 'ใบนี้ยกเลิกแล้ว ไม่ต้องส่ง');
    await this.db.transaction(async (tx) => {
      await tx.update(s.etaxJobs).set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()`, byStaff: staff.id, updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
      if (kind === 'tax_document' && action === 'issue') await tx.update(s.taxDocuments).set({ status: 'pending', providerRef: null, updatedAt: new Date() }).where(and(eq(s.taxDocuments.id, id), eq(s.taxDocuments.status, 'failed')));
      await audit(tx, staff, d.workspaceId, 'plan', action === 'cancel' ? 'ops.etax_cancel_retry' : 'ops.etax_retry', `${action === 'cancel' ? 'แจ้งยกเลิก e-Tax อีกครั้ง' : 'ส่ง e-Tax ใหม่'} ${d.number}`, { type: kind, id });
    });
    return { id, action, status: 'pending' as const };
  }

  /** ตรวจสถานะ: ให้งานกวาดถามผู้ให้บริการในรอบถัดไป (≤ 10 นาที) */
  async check(staff: Staff, kind: DocKind, id: string) {
    const d = await this.doc(kind, id);
    const jobs = await this.db.select().from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, kind), eq(s.etaxJobs.docId, id), eq(s.etaxJobs.status, 'submitted')));
    if (!jobs.length) throw new AppError(409, 'not_waiting', 'เอกสารนี้ไม่ได้รอผลจากผู้ให้บริการ');
    await this.db.update(s.etaxJobs).set({ nextAttemptAt: sql`now()`, updatedAt: new Date() }).where(inArray(s.etaxJobs.id, jobs.map((j) => j.id)));
    await staffAudit(this.db, staff, 'ops.etax_check', `ตรวจสถานะ e-Tax ${d.number}`, { type: kind, id }, d.workspaceId);
    return { id, queued: jobs.length };
  }

  /** E4 · บันทึกว่ายกเลิกที่ผู้ให้บริการแล้ว (ผ่านหน้าเว็บของผู้ให้บริการ) · หยุดลองแจ้งอัตโนมัติ · ผลต่างจากนี้ภายหลัง แถวกลับมา */
  async manualCancel(staff: Staff, kind: DocKind, id: string, input: z.infer<typeof ManualCancelBody>) {
    const { d, job } = await this.job(kind, id, 'cancel');
    if (!job) throw new AppError(409, 'no_cancel_job', 'เอกสารนี้ไม่ได้รอแจ้งยกเลิกที่ผู้ให้บริการ');
    if (job.status === 'done' || job.status === 'manual') throw new AppError(409, 'already_cancelled', 'บันทึกการยกเลิกที่ผู้ให้บริการแล้ว', { status: job.status });
    await this.db.transaction(async (tx) => {
      await tx.update(s.etaxJobs).set({ status: 'manual', providerRef: input.reference, note: input.reason, nextAttemptAt: null, byStaff: staff.id, updatedAt: new Date() }).where(eq(s.etaxJobs.id, job.id));
      await audit(tx, staff, d.workspaceId, 'plan', 'ops.etax_cancel_manual', `บันทึกว่ายกเลิก ${d.number} ที่ผู้ให้บริการแล้ว · อ้างอิง ${input.reference} · ${input.reason}`, { type: kind, id });
    });
    return { id, status: 'manual' as const, reference: input.reference };
  }

  /** ขอข้อมูลใหม่: ข้อมูลผู้ซื้อผิด (เลขผู้เสียภาษี สาขา) → อีเมลผู้ติดต่อด้านบัญชีพร้อมลิงก์แก้ข้อมูลออกใบกำกับ */
  async requestInfo(staff: Staff, id: string, input: z.infer<typeof RequestInfoBody>) {
    const d = await this.doc('tax_document', id);
    const [ws] = await this.db.select({ slug: s.workspaces.slug, name: s.workspaces.name }).from(s.workspaces).where(eq(s.workspaces.id, d.workspaceId));
    const [job] = await this.db.select({ lastError: s.etaxJobs.lastError }).from(s.etaxJobs).where(and(eq(s.etaxJobs.docKind, 'tax_document'), eq(s.etaxJobs.docId, id), eq(s.etaxJobs.action, 'issue')));
    const to = await billingContacts(this.db, d.workspaceId);
    const sent = await mailAll(this.mail, to, `กรุณาตรวจข้อมูลออกใบกำกับภาษี · ${d.number} · Friday Work Management`, [
      `ผู้ให้บริการใบกำกับภาษีอิเล็กทรอนิกส์ยังออกเอกสาร ${d.number} ให้ ${ws?.name ?? ''} ไม่ได้${job?.lastError ? ` (${job.lastError})` : ''}`,
      ...(input.message ? [input.message] : []),
      `กรุณาตรวจชื่อบริษัท เลขประจำตัวผู้เสียภาษี 13 หลัก สาขา และที่อยู่ แล้วแก้ไขที่ ${config.appUrl}/work/${ws?.slug}/billing`,
      'เมื่อแก้แล้วทีม Friday จะออกใบกำกับภาษีฉบับใหม่ให้',
    ].join('\n'));
    await audit(this.db, staff, d.workspaceId, 'plan', 'ops.etax_info_requested', `ขอข้อมูลออกใบกำกับภาษีใหม่ ${d.number} · ส่งถึง ${sent} อีเมล`, { type: 'tax_document', id });
    return { id, sent, to };
  }

  /** งานรายชั่วโมง: งาน e-Tax ที่ล้มครบ 3 ครั้ง → แจ้งการเงิน (Push) ครั้งเดียวต่อการล้มแต่ละรอบ */
  async notifyFailures() {
    const failed = await this.rows<{ id: string; number: string | null; action: string; at: string; lastError: string | null }>(sql`
      select j.id, coalesce(d.number, c.number, x.number) as number, j.action, coalesce(j.last_attempt_at, j.updated_at)::text as at, j.last_error as "lastError"
      from etax_jobs j left join tax_documents d on j.doc_kind = 'tax_document' and d.id = j.doc_id
        left join credit_notes c on j.doc_kind = 'credit_note' and c.id = j.doc_id left join debit_notes x on j.doc_kind = 'debit_note' and x.id = j.doc_id
      where j.status = 'failed' and j.updated_at > now() - interval '7 days'`);
    if (!failed.length) return 0;
    const finance = await this.rows<{ email: string }>(sql`select email from staff_users where status = 'active' and roles && array['finance']::text[] and (expires_at is null or expires_at > now())`);
    let n = 0;
    for (const f of failed) {
      const title = f.action === 'cancel' ? 'แจ้งยกเลิก e-Tax ไม่สำเร็จ' : 'ส่ง e-Tax ไม่สำเร็จ';
      const body = `${f.number ?? ''}${f.lastError ? ` · ${f.lastError}` : ''}`;
      const sent = await this.push.once(`etax-failed:${f.id}:${f.at}`, async () => {
        await this.push.toRoles(['finance'], { title, body: body.slice(0, 160), url: '/payments?tab=tax', tag: `etax-${f.id}` });
        await mailAll(this.mail, finance.map((x) => x.email), `${title} · ${f.number ?? ''}`, `${body}\nดูและส่งใหม่ได้ที่ ${config.origin}/payments?tab=tax`);
      });
      if (sent) n++;
    }
    return n;
  }
}
