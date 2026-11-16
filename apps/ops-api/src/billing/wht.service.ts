import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { sellerFromEnv } from '@friday/docs';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PushService } from '../push/push.service.js';
import { addDays, baht, todayBkk } from './ledger.js';

const s = schema;
type Row = Record<string, unknown>;

/** 50 ทวิ ต้องส่งภายใน 30 วันหลังชำระ · ขออัตโนมัติวันที่ 7 และ 30 (คำตัดสินรอบ 4 ข้อ 1) */
export const WHT_DUE_DAYS = 30;
export const WHT_AUTO_DAYS = [7, 30] as const;
/** งานขอ 50 ทวิ อัตโนมัติรันทุกเช้าตั้งแต่ 08:00 (เวลาไทย) */
const WHT_RUN_HOUR = 8;
/** จับคู่ไฟล์ e-WHT: วันที่หักห่างจากวันที่ชำระได้ ±3 วัน · ยอดคลาด ≤ 1 บาท */
const EWHT_DAYS = 3;
const EWHT_TOLERANCE = 100;
/** อัตราที่ยอมรับสำหรับ e-WHT (ไม่บังคับ 3% · รอนักบัญชียืนยันอัตราปี 2569) */
const EWHT_RATES = [1, 2, 3];

export const WhtRequestBody = z.object({ recipients: z.array(z.email().trim().toLowerCase()).min(1).max(10), message: z.string().trim().max(1000).optional() }).strict();
export const WhtCloseBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
/** นำเข้าไฟล์ e-WHT (E9) · apply=false = ดูผลจับคู่ก่อน · matches = จับคู่เอง { เลขบรรทัด: id ใบแจ้งหนี้ } */
export const EwhtImportBody = z
  .object({
    csv: z.string().min(1).max(2_000_000),
    filename: z.string().trim().max(200).optional(),
    apply: z.boolean().default(false),
    matches: z.record(z.string().regex(/^\d+$/), z.uuid()).default({}),
  })
  .strict();

/** สาเหตุที่ 50 ทวิ ไม่ผ่าน (E8 · ลูกค้าเห็น) */
export const WHT_REJECT_REASONS = {
  name_mismatch: 'ชื่อหรือเลขประจำตัวผู้เสียภาษีของผู้ถูกหักไม่ตรง',
  amount_mismatch: 'ยอดเงินได้หรือภาษีที่หักไม่ตรงกับใบแจ้งหนี้',
  no_signature: 'ไม่มีลายมือชื่อหรือตราผู้มีหน้าที่หัก',
  unreadable: 'ไฟล์อ่านไม่ได้ หรือไม่ใช่ 50 ทวิ',
} as const;

export type WhtState = 'waiting' | 'review' | 'overdue' | 'ewht' | 'received' | 'uncollected';

interface EwhtLine {
  line: number;
  payerTaxId: string;
  payerName: string;
  amount: number;
  date: string;
  reference: string;
}

/** แยก CSV (รองรับเครื่องหมายคำพูด · BOM · บรรทัด CRLF) */
export function parseCsv(text: string) {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) out.push(row);
      (row = []), (cell = '');
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) out.push(row);
  return out;
}

/** วันที่ในไฟล์: YYYY-MM-DD หรือ DD/MM/YYYY (ปี พ.ศ. แปลงเป็น ค.ศ.) */
function isoDate(v: string) {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const y = Number(t.slice(0, 4));
    return y > 2400 ? `${y - 543}${t.slice(4)}` : t;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const y = Number(m[3]) > 2400 ? Number(m[3]) - 543 : Number(m[3]);
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * อ่านไฟล์ e-WHT (ดาวน์โหลดจากระบบ e-Withholding Tax ของกรมสรรพากร แล้วบันทึกเป็น CSV) · ต้องมีหัวคอลัมน์
 * payer_tax_id, payer_name, tax_amount, date, reference (หรือหัวภาษาไทย: เลขประจำตัวผู้เสียภาษีผู้หัก, ชื่อผู้หัก, ภาษีที่หัก, วันที่หัก, เลขอ้างอิง)
 */
export function parseEwht(csv: string): { lines: EwhtLine[]; errors: { line: number; message: string }[] } {
  const rows = parseCsv(csv);
  if (!rows.length) throw new AppError(422, 'ewht_empty', 'ไฟล์ว่าง');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const idx = {
    taxId: col('payer_tax_id', 'เลขประจำตัวผู้เสียภาษีผู้หัก', 'เลขผู้เสียภาษีผู้หัก'),
    name: col('payer_name', 'ชื่อผู้หัก'),
    amount: col('tax_amount', 'ภาษีที่หัก'),
    date: col('date', 'วันที่หัก', 'วันที่จ่าย'),
    ref: col('reference', 'เลขอ้างอิง'),
  };
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new AppError(422, 'ewht_columns', 'หัวคอลัมน์ไม่ครบ ต้องมี payer_tax_id, payer_name, tax_amount, date, reference', { missing });
  const lines: EwhtLine[] = [];
  const errors: { line: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const taxId = (r[idx.taxId] ?? '').replace(/\D/g, '');
    const amount = Math.round(Number((r[idx.amount] ?? '').replace(/[,฿\s]/g, '')) * 100);
    const date = isoDate(r[idx.date] ?? '');
    if (taxId.length !== 13) return errors.push({ line, message: 'เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก' });
    if (!Number.isFinite(amount) || amount <= 0) return errors.push({ line, message: 'ยอดภาษีไม่ถูกต้อง' });
    if (!date) return errors.push({ line, message: 'วันที่ต้องเป็น YYYY-MM-DD หรือ DD/MM/YYYY' });
    lines.push({ line, payerTaxId: taxId, payerName: (r[idx.name] ?? '').trim(), amount, date, reference: (r[idx.ref] ?? '').trim() });
  });
  if (lines.length > 2000) throw new AppError(422, 'ewht_too_many', 'นำเข้าได้ครั้งละไม่เกิน 2,000 รายการ');
  return { lines, errors };
}

/**
 * 50 ทวิ (รอบ 4 · E7–E11): รายการติดตาม · ขออัตโนมัติวันที่ 7 และ 30 หลังชำระ · ขออีกครั้ง · ปิดว่าไม่ได้รับ · นำเข้าไฟล์ e-WHT
 * กำหนดส่ง = วันที่ชำระ + 30 วัน · เลยกำหนดลูกค้ายังอัปโหลดได้ (หน้าจอขึ้น "เลยกำหนด")
 */
@Injectable()
export class WhtService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsWht');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    // ตรวจทุกชั่วโมง ส่งจริงตั้งแต่ 08:00 (เวลาไทย) · ส่งแล้วบันทึกใน wht_requests จึงไม่ส่งซ้ำ · test เรียก runRequests เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.runRequests().catch((e) => this.log.error(`ขอ 50 ทวิ อัตโนมัติล้ม: ${String(e)}`)), 3_600_000);
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

  /** ใบที่ลูกค้าหัก ณ ที่จ่าย + 50 ทวิ ล่าสุด + การขอ · `extra` = เงื่อนไขเพิ่ม */
  private items(extra: SQL) {
    return this.rows<Row>(sql`
      select i.id, i.number, i.subtotal::float8 as subtotal, i.wht_amount::float8 as "whtAmount", i.paid_at as "paidAt",
        to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as "paidOn",
        to_char((i.paid_at at time zone 'Asia/Bangkok')::date + ${WHT_DUE_DAYS}::int, 'YYYY-MM-DD') as "dueBy",
        json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as workspace,
        c.id as "certId", c.status as "certStatus", c.source as "certSource", c.created_at as "certAt", c.reject_reason as "rejectReason", c.ewht_ref as "ewhtRef", c.decided_at as "decidedAt", c.file_key is not null as "hasFile",
        coalesce(r.n, 0)::int as requests, r.last_at as "lastRequestAt", r.last_kind as "lastRequestKind", coalesce(r.kinds, '{}') as "requestKinds",
        r.last_at is not null and to_char(r.last_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') = ${todayBkk()} as "requestedToday"
      from invoices i join workspaces w on w.id = i.workspace_id
        left join lateral (select * from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1) c on true
        left join lateral (select count(*) as n, max(q.created_at) as last_at, (array_agg(q.kind order by q.created_at desc))[1] as last_kind, array_agg(distinct q.kind) as kinds from wht_requests q where q.invoice_id = i.id) r on true
      where i.status = 'paid' and i.wht_amount > 0 and i.paid_at is not null and ${extra}
      order by i.paid_at`);
  }

  private shape(r: Row) {
    const status = r.certStatus as string | null;
    const today = todayBkk();
    const state: WhtState =
      status === 'confirmed' ? 'received' : status === 'uncollected' ? 'uncollected' : status === 'pending_review' ? 'review' : status === 'pending_ewht' ? 'ewht' : (r.dueBy as string) < today ? 'overdue' : 'waiting';
    const kinds = (r.requestKinds as string[]) ?? [];
    const days = Math.round((Date.parse(today) - Date.parse(r.paidOn as string)) / 86_400_000);
    // ขออัตโนมัติครั้งถัดไป (เฉพาะใบที่ยังรอรับ)
    const nextAuto = state === 'waiting' || state === 'overdue' ? (days < 7 && !kinds.includes('auto_7') && !kinds.includes('auto_30') ? addDays(r.paidOn as string, 7) : !kinds.includes('auto_30') ? addDays(r.paidOn as string, 30) : null) : null;
    return {
      invoice: { id: r.id as string, number: r.number as string, subtotal: Number(r.subtotal) },
      workspace: r.workspace as { id: string; slug: string; name: string },
      whtAmount: Number(r.whtAmount),
      paidAt: r.paidAt, paidOn: r.paidOn as string, dueBy: r.dueBy as string,
      daysLeft: Math.round((Date.parse(r.dueBy as string) - Date.parse(today)) / 86_400_000),
      state,
      certificate: r.certId ? { id: r.certId as string, status, source: r.certSource as string, at: r.certAt, rejectReason: (r.rejectReason as string | null) ?? null, ewhtRef: (r.ewhtRef as string | null) ?? null, decidedAt: r.decidedAt ?? null, hasFile: !!r.hasFile } : null,
      requests: { count: Number(r.requests), lastAt: r.lastRequestAt ?? null, lastKind: (r.lastRequestKind as string | null) ?? null, today: !!r.requestedToday },
      nextAuto,
    };
  }

  /** รายการติดตาม (ทุกเดือน) + ที่ได้รับแล้วในเดือน + ตัวเลขสรุปของใบที่ชำระในเดือน */
  async list(month: string) {
    const open = (await this.items(sql`(c.id is null or c.status in ('pending_review', 'rejected', 'pending_ewht'))`)).map((r) => this.shape(r));
    const received = (await this.items(sql`c.status in ('confirmed', 'uncollected') and to_char(coalesce(c.decided_at, c.updated_at) at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`)).map((r) => this.shape(r));
    const inMonth = (await this.items(sql`to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM') = ${month}`)).map((r) => this.shape(r));
    const n = (list: { state: WhtState }[], st: WhtState) => list.filter((x) => x.state === st).length;
    return {
      items: [...open, ...received],
      counts: { follow: open.length, waiting: n(open, 'waiting'), review: n(open, 'review'), overdue: n(open, 'overdue'), ewht: n(open, 'ewht'), received: received.length },
      kpi: { total: inMonth.length, received: n(inMonth, 'received'), waiting: n(inMonth, 'waiting'), review: n(inMonth, 'review'), overdue: n(inMonth, 'overdue'), ewht: n(inMonth, 'ewht'), uncollected: n(inMonth, 'uncollected') },
    };
  }

  private async one(invoiceId: string) {
    if (!z.uuid().safeParse(invoiceId).success) throw new AppError(404, 'not_found', 'ไม่พบใบแจ้งหนี้');
    const [r] = await this.items(sql`i.id = ${invoiceId}`);
    if (!r) throw new AppError(404, 'not_found', 'ไม่พบใบแจ้งหนี้ที่หัก ณ ที่จ่าย');
    return this.shape(r);
  }

  /** ผู้ติดต่อของลูกค้าสำหรับขอ 50 ทวิ (E7): ผู้ติดต่อด้านบัญชี (อีเมลรับใบกำกับภาษี) + Owner / Admin */
  async contacts(workspaceId: string) {
    const [profile] = await this.db.select({ taxEmail: s.billingProfiles.taxEmail, companyName: s.billingProfiles.companyName }).from(s.billingProfiles).where(eq(s.billingProfiles.workspaceId, workspaceId));
    const members = await this.rows<{ email: string; name: string | null; role: string }>(sql`
      select lower(u.email) as email, u.display_name as name, m.role from workspace_members m join users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId} and m.status = 'active' and m.role in ('owner', 'admin') order by m.role desc, u.display_name`);
    const list: { email: string; name: string | null; role: 'accounting' | 'owner' | 'admin' }[] = [];
    if (profile?.taxEmail) list.push({ email: profile.taxEmail.toLowerCase(), name: null, role: 'accounting' });
    for (const m of members) if (!list.some((x) => x.email === m.email)) list.push({ email: m.email, name: m.name, role: m.role as 'owner' | 'admin' });
    return list;
  }

  /** E7 · รายละเอียดก่อนขออีกครั้ง */
  async detail(invoiceId: string) {
    const item = await this.one(invoiceId);
    const requests = await this.db.select().from(s.whtRequests).where(eq(s.whtRequests.invoiceId, invoiceId)).orderBy(desc(s.whtRequests.createdAt));
    return { ...item, history: requests.map((q) => ({ id: q.id, kind: q.kind, at: q.createdAt, recipients: q.recipients, message: q.message, sentBy: q.sentBy })), contacts: await this.contacts(item.workspace.id) };
  }

  /** อีเมลขอ 50 ทวิ (E10) · ข้อมูลผู้ถูกหัก = ผู้ขาย (Friday) · เงินได้ก่อน VAT และภาษีที่หัก */
  private letter(item: ReturnType<WhtService['shape']>, round: { n: number; of?: number } | null, message?: string) {
    const seller = sellerFromEnv();
    const rate = item.invoice.subtotal > 0 ? Math.round((item.whtAmount / item.invoice.subtotal) * 100) : 3;
    const subject = `ขอหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) · ${item.invoice.number} · ส่งภายใน ${item.dueBy}`;
    const text = [
      `เรียน ทีมบัญชี ${item.workspace.name}`,
      `ขอบคุณที่ชำระใบแจ้งหนี้ ${item.invoice.number} เมื่อ ${item.paidOn} แบบหักภาษี ณ ที่จ่าย กรุณาส่งหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ภายใน ${item.dueBy}`,
      ...(message ? ['', message] : []),
      '',
      `ผู้ถูกหักภาษี: ${seller.name} · ${seller.branch}`,
      `เลขประจำตัวผู้เสียภาษี: ${seller.taxId}`,
      `เงินได้ที่จ่าย: ${baht(item.invoice.subtotal)} (ก่อน VAT)`,
      `ภาษีที่หัก ${rate}%: ${baht(item.whtAmount)}`,
      'ประเภทเงินได้: ค่าบริการ · แบบ ภ.ง.ด.53',
      '',
      `อัปโหลด 50 ทวิ หรือแจ้งว่าหักผ่าน e-Withholding Tax แล้ว: ${config.appUrl}/work/${item.workspace.slug}/billing/invoices/${item.invoice.id}`,
      'ถ้าหักผ่าน e-Withholding Tax ไม่ต้องส่งเอกสาร ทีมเราจะตรวจกับกรมสรรพากรให้',
      ...(round ? ['', `ส่งเพราะคุณเป็นผู้ติดต่อด้านบัญชีของ ${item.workspace.name}${round.of ? ` · ครั้งที่ ${round.n} จาก ${round.of}` : ''}`] : []),
    ].join('\n');
    return { subject, text };
  }

  private async send(to: string[], subject: string, text: string) {
    const ok: string[] = [];
    for (const t of to) {
      try {
        await this.mail.send({ to: t, subject, text });
        ok.push(t);
      } catch {
        /* Mailer บันทึก log แล้ว */
      }
    }
    return ok;
  }

  private assertOpen(item: ReturnType<WhtService['shape']>) {
    if (item.state === 'received') throw new AppError(409, 'wht_received', 'ได้รับ 50 ทวิ ของใบนี้แล้ว');
    if (item.state === 'uncollected') throw new AppError(409, 'wht_closed', 'ปิดรายการนี้ว่าไม่ได้รับแล้ว');
  }

  /** E7 · ขออีกครั้ง / ขอตอนนี้ · วันละ 1 ครั้งต่อใบ · ส่งได้เฉพาะผู้ติดต่อของลูกค้า */
  async request(staff: Staff, invoiceId: string, input: z.infer<typeof WhtRequestBody>) {
    const item = await this.one(invoiceId);
    this.assertOpen(item);
    if (item.state === 'review') throw new AppError(409, 'wht_in_review', 'ลูกค้าส่ง 50 ทวิ แล้ว รอตรวจ');
    if (item.requests.today) throw new AppError(409, 'wht_requested_today', 'วันนี้ขอ 50 ทวิ ของใบนี้ไปแล้ว ขอได้วันละ 1 ครั้ง');
    const contacts = (await this.contacts(item.workspace.id)).map((c) => c.email);
    const outside = input.recipients.filter((r) => !contacts.includes(r));
    if (outside.length) throw new AppError(422, 'recipient_not_contact', 'ส่งได้เฉพาะผู้ติดต่อด้านบัญชี Owner หรือ Admin ของลูกค้า', { outside, contacts });
    const { subject, text } = this.letter(item, null, input.message);
    const sent = await this.send(input.recipients, subject, text);
    if (!sent.length) throw new AppError(502, 'mail_failed', 'ส่งอีเมลไม่สำเร็จ ลองใหม่อีกครั้ง');
    await this.db.transaction(async (tx) => {
      await tx.insert(s.whtRequests).values({ workspaceId: item.workspace.id, invoiceId, kind: 'manual', recipients: sent, message: input.message ?? null, sentBy: staff.id });
      await audit(tx, staff, item.workspace.id, 'plan', 'ops.wht_requested', `ขอ 50 ทวิ ${item.invoice.number} อีกครั้ง · ถึง ${sent.join(', ')}`, { type: 'invoice', id: invoiceId });
    });
    return { invoiceId, sent, kind: 'manual' as const };
  }

  /** ปิดว่าไม่ได้รับ (ต้องกรอกเหตุผล) · ออกจากรายการติดตาม · CSV ให้บัญชีระบุว่า "ไม่ได้รับ" */
  async close(staff: Staff, invoiceId: string, input: z.infer<typeof WhtCloseBody>) {
    const item = await this.one(invoiceId);
    this.assertOpen(item);
    await this.db.transaction(async (tx) => {
      await tx.insert(s.whtCertificates).values({ workspaceId: item.workspace.id, invoiceId, source: 'ops', status: 'uncollected', rejectReason: input.reason, reviewedBy: staff.id, decidedAt: new Date() });
      await audit(tx, staff, item.workspace.id, 'plan', 'ops.wht_uncollected', `ปิด 50 ทวิ ${item.invoice.number} ว่าไม่ได้รับ · ${input.reason}`, { type: 'invoice', id: invoiceId });
    });
    return { invoiceId, status: 'uncollected' as const };
  }

  /**
   * E9 · นำเข้าไฟล์ e-WHT: จับคู่เลขผู้เสียภาษีของลูกค้า + ยอดภาษี + วันที่ชำระ (±3 วัน) · ปิดเป็น "e-WHT · ปิดเอง"
   * ยอด: ตรงกับยอดหักในใบ หรือ 1–3% ของมูลค่าก่อน VAT (ไม่บังคับ 3% สำหรับ e-WHT) · นำเข้าซ้ำได้ ไม่ปิดรายการเดิมซ้ำ
   */
  async importEwht(staff: Staff, input: z.infer<typeof EwhtImportBody>) {
    const { lines, errors } = parseEwht(input.csv);
    const open = await this.rows<{ id: string; number: string; subtotal: number; wht: number; paidOn: string; taxId: string | null; ws: { id: string; slug: string; name: string }; certId: string | null; certStatus: string | null; ewhtRef: string | null }>(sql`
      select i.id, i.number, i.subtotal::float8 as subtotal, i.wht_amount::float8 as wht, to_char(i.paid_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as "paidOn",
        regexp_replace(b.tax_id, '[^0-9]', '', 'g') as "taxId", json_build_object('id', w.id, 'slug', w.slug, 'name', w.name) as ws, c.id as "certId", c.status as "certStatus", c.ewht_ref as "ewhtRef"
      from invoices i join workspaces w on w.id = i.workspace_id left join billing_profiles b on b.workspace_id = i.workspace_id
        left join lateral (select * from wht_certificates c where c.invoice_id = i.id order by c.created_at desc limit 1) c on true
      where i.status = 'paid' and i.wht_amount > 0 and i.paid_at is not null`);
    const amountOk = (inv: (typeof open)[number], amount: number) => Math.abs(amount - inv.wht) <= EWHT_TOLERANCE || EWHT_RATES.some((r) => Math.abs(amount - Math.round((inv.subtotal * r) / 100)) <= EWHT_TOLERANCE);
    const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
    const used = new Set<string>();
    const rows = lines.map((l) => {
      const manual = input.matches[String(l.line)];
      // นำเข้าซ้ำ: เลขอ้างอิงเดิมปิดไปแล้ว
      const already = open.find((i) => i.certStatus === 'confirmed' && l.reference && i.ewhtRef === l.reference);
      if (already) return { ...l, status: 'already' as const, match: { invoiceId: already.id, number: already.number, workspace: already.ws } };
      const candidates = manual
        ? open.filter((i) => i.id === manual)
        : open.filter((i) => i.taxId === l.payerTaxId && days(i.paidOn, l.date) <= EWHT_DAYS && amountOk(i, l.amount)).sort((a, b) => days(a.paidOn, l.date) - days(b.paidOn, l.date));
      const inv = candidates.find((i) => !used.has(i.id) && i.certStatus !== 'confirmed' && i.certStatus !== 'uncollected');
      if (!inv) return { ...l, status: manual ? ('invalid' as const) : ('unmatched' as const), match: null };
      used.add(inv.id);
      const rate = inv.subtotal > 0 ? Math.round((l.amount / inv.subtotal) * 1000) / 10 : null;
      return { ...l, status: 'matched' as const, manual: !!manual, rate, match: { invoiceId: inv.id, number: inv.number, workspace: inv.ws } };
    });
    const matched = rows.filter((r) => r.status === 'matched');
    let closed = 0;
    if (input.apply && matched.length) {
      await this.db.transaction(async (tx) => {
        for (const r of matched) {
          const inv = open.find((i) => i.id === r.match!.invoiceId)!;
          const ref = r.reference || `e-WHT ${r.date}`;
          // ลูกค้าแจ้ง e-WHT ไว้แล้ว → ปิดแถวเดิม · ไม่ได้แจ้ง → เพิ่มแถวใหม่ที่ปิดแล้ว
          if (inv.certStatus === 'pending_ewht' && inv.certId) await tx.update(s.whtCertificates).set({ status: 'confirmed', source: 'ewht', ewhtRef: ref, reviewedBy: staff.id, decidedAt: new Date(), updatedAt: new Date() }).where(eq(s.whtCertificates.id, inv.certId));
          else await tx.insert(s.whtCertificates).values({ workspaceId: inv.ws.id, invoiceId: inv.id, source: 'ewht', status: 'confirmed', ewhtRef: ref, reviewedBy: staff.id, decidedAt: new Date() });
          await audit(tx, staff, inv.ws.id, 'plan', 'ops.wht_ewht_matched', `ปิด 50 ทวิ ${inv.number} ด้วยรายการ e-WHT ${ref} · ภาษี ${baht(r.amount)} วันที่ ${r.date}${r.manual ? ' · จับคู่เอง' : ''}${input.filename ? ` · ไฟล์ ${input.filename}` : ''}`, { type: 'invoice', id: inv.id });
          closed++;
        }
      });
    }
    const dates = lines.map((l) => l.date).sort();
    return { rows, errors, period: dates.length ? { from: dates[0], to: dates.at(-1)! } : null, matched: matched.length, unmatched: rows.filter((r) => r.status === 'unmatched').length, closed, applied: input.apply };
  }

  /**
   * งานทุกเช้า 08:00: ขอ 50 ทวิ อัตโนมัติวันที่ 7 (ผู้ติดต่อด้านบัญชี) และ 30 (วันครบกำหนด · ผู้ติดต่อด้านบัญชีและ Owner) หลังชำระ
   * ไม่ขอใบที่ลูกค้าส่งแล้ว / แจ้ง e-WHT / ปิดแล้ว · งานหยุดไปหลายวันส่งเฉพาะครั้งล่าสุด · เลยกำหนด → แจ้งการเงินครั้งเดียว
   * `now` ให้ test ส่งเวลาเอง · เรียกซ้ำในวันเดียวกันไม่ส่งซ้ำ (ดูจาก wht_requests)
   */
  async runRequests(now = new Date()) {
    const bkk = new Date(now.getTime() + 7 * 3_600_000);
    if (bkk.getUTCHours() < WHT_RUN_HOUR) return { sent: [] as string[], overdue: 0 };
    const today = bkk.toISOString().slice(0, 10);
    const list = (await this.items(sql`(c.id is null or c.status = 'rejected')`)).map((r) => this.shape(r));
    const sent: string[] = [];
    let overdue = 0;
    for (const item of list) {
      const days = Math.round((Date.parse(today) - Date.parse(item.paidOn)) / 86_400_000);
      const [kinds] = await this.rows<{ k: string[] }>(sql`select coalesce(array_agg(kind), '{}') as k from wht_requests where invoice_id = ${item.invoice.id}`);
      const has = (k: string) => kinds.k.includes(k);
      const kind = days >= 30 && !has('auto_30') ? 'auto_30' : days >= 7 && days < 30 && !has('auto_7') && !has('auto_30') ? 'auto_7' : null;
      if (kind) {
        const contacts = await this.contacts(item.workspace.id);
        // วัน 7: ผู้ติดต่อด้านบัญชี · วัน 30: ผู้ติดต่อด้านบัญชีและ Owner · ไม่มีผู้ติดต่อด้านบัญชีใช้ Owner / Admin
        const accounting = contacts.filter((c) => c.role === 'accounting');
        const to = (kind === 'auto_7' ? (accounting.length ? accounting : contacts) : contacts.filter((c) => c.role !== 'admin' || !accounting.length)).map((c) => c.email);
        const { subject, text } = this.letter(item, { n: kind === 'auto_7' ? 1 : 2, of: 2 });
        const ok = await this.send(to, subject, text);
        await this.db.transaction(async (tx) => {
          await tx.insert(s.whtRequests).values({ workspaceId: item.workspace.id, invoiceId: item.invoice.id, kind, recipients: ok });
          await tx.insert(s.auditLogs).values({ workspaceId: item.workspace.id, actorKind: 'system', category: 'plan', action: 'billing.wht_requested', targetType: 'invoice', targetId: item.invoice.id, summary: `ขอ 50 ทวิ ${item.invoice.number} อัตโนมัติ (วันที่ ${kind === 'auto_7' ? 7 : 30} หลังชำระ) · ถึง ${ok.join(', ') || '-'}` });
        });
        sent.push(`${item.invoice.number}:${kind}`);
      }
      if (days > WHT_DUE_DAYS) {
        const pushed = await this.push.once(`wht-overdue:${item.invoice.id}`, () => this.push.toRoles(['finance'], { title: '50 ทวิ เลยกำหนด', body: `${item.invoice.number} · ${item.workspace.name} · ${baht(item.whtAmount)}`, url: '/payments?tab=tax', tag: `wht-${item.invoice.id}` }));
        if (pushed) overdue++;
      }
    }
    if (sent.length) this.log.log(`ขอ 50 ทวิ อัตโนมัติ ${sent.length} ใบ`);
    return { sent, overdue };
  }
}
