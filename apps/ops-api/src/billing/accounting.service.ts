import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { monthDocumentsZip, zip, type ZipEntry } from '@friday/docs';
import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { staffAudit } from '../audit.js';
import type { Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { PushService } from '../push/push.service.js';
import { BillingService } from './billing.service.js';
import { todayBkk, vatRegistered } from './ledger.js';

const s = schema;
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'รูปแบบเดือนต้องเป็น YYYY-MM');
/** ไฟล์ให้สำนักงานบัญชี: รายงานภาษีขาย (PDF + Excel) · 50 ทวิ (CSV) · เอกสารภาษีทั้งเดือน (ZIP) */
export const EXPORT_TYPES = ['sales_tax', 'wht', 'zip'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];
const FILE_LABEL: Record<ExportType, string[]> = { sales_tax: ['PDF', 'Excel'], wht: ['CSV'], zip: ['ZIP'] };
const TYPE_LABEL: Record<ExportType, string> = { sales_tax: 'รายงานภาษีขาย (PDF + Excel)', wht: '50 ทวิ (CSV)', zip: 'เอกสารภาษีทั้งเดือน (ZIP)' };

export const SendExportBody = z.object({ month: Month, types: z.array(z.enum(EXPORT_TYPES)).min(1).max(3).optional() }).strict();
export const ExportZipQuery = z.object({ month: Month, scope: z.enum(['docs', 'all']).default('docs') });
/** ค่าตั้งการส่งสำนักงานบัญชี (E6) · เก็บใน ops_settings key `accounting` */
export const AccountingSettingsBody = z
  .object({
    recipients: z.array(z.email().trim().toLowerCase()).max(5, 'ผู้รับสูงสุด 5 อีเมล'),
    auto: z.boolean(),
    day: z.number().int().min(1).max(15),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'เวลาต้องเป็น HH:MM'),
    /** ถึงวันส่งแล้วงวดยังไม่ปิด: wait = รอจนปิดแล้วส่งทันที · draft = ส่งฉบับร่างตามกำหนด แล้วส่งฉบับจริงเมื่อปิด */
    whenOpen: z.enum(['wait', 'draft']),
    files: z.object({ salesTax: z.boolean(), wht: z.boolean(), zip: z.boolean() }).strict(),
  })
  .strict()
  .refine((v) => !v.auto || v.recipients.length > 0, { message: 'เปิดส่งอัตโนมัติต้องมีผู้รับอย่างน้อย 1 อีเมล', path: ['recipients'] })
  .refine((v) => v.files.salesTax || v.files.wht || v.files.zip, { message: 'เลือกไฟล์อย่างน้อย 1 ชนิด', path: ['files'] });
export type AccountingSettings = z.infer<typeof AccountingSettingsBody>;

const prevMonth = (date: string) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
/** เวลาไทยตอนนี้ (YYYY-MM-DD, HH:MM) · สตริงวันที่ = สิ้นวันนั้น (test / ส่งย้อนหลัง) */
const bkkNow = (at: string | Date) => {
  if (typeof at === 'string') return { date: at.slice(0, 10), time: '23:59' };
  const iso = new Date(at.getTime() + 7 * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

/**
 * ส่งให้สำนักงานบัญชี (B8 · รอบ 4 E5–E6): ค่าตั้งในหน้าจอแทน environment · ประวัติการส่งทุกครั้ง (ส่งแล้ว / ล้ม / ไม่ได้ส่งเพราะงวดยังไม่ปิด)
 * ประวัติเก็บใน staff_audit_logs (billing.export_sent · export_failed · export_skipped) · reason ขึ้นต้นด้วยงวด YYYY-MM
 */
@Injectable()
export class AccountingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OpsAccounting');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly mail: Mailer,
    private readonly push: PushService,
    private readonly billing: BillingService,
  ) {}

  onModuleInit() {
    // ส่งให้สำนักงานบัญชีตามวันเวลาที่ตั้งไว้ · ตรวจทุกชั่วโมง (ทำซ้ำได้ ไม่ส่งซ้ำ) · test เรียก autoSendExport เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.autoSendExport().catch((e) => this.log.error(`ส่งไฟล์ให้สำนักงานบัญชีล้ม: ${String(e)}`)), 3_600_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<T = Record<string, unknown>>(q: SQL) {
    const r = await this.db.execute(q);
    return ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as T[];
  }

  // ---------------------------------------------------------------- ค่าตั้ง (E6)

  /** ยังไม่เคยบันทึกในหน้าจอ = ค่าเดิมจาก OPS_ACCOUNTING_EMAIL / OPS_ACCOUNTING_SEND_DAY · บันทึกแล้วใช้ค่าในหน้าจอเท่านั้น */
  async settings(): Promise<AccountingSettings & { source: 'env' | 'saved'; updatedAt: Date | null; updatedBy: string | null }> {
    const [row] = await this.db.select().from(s.opsSettings).where(eq(s.opsSettings.key, 'accounting'));
    const recipients = config.accountingEmails.slice(0, 5).map((e) => e.toLowerCase());
    const base: AccountingSettings = { recipients, auto: recipients.length > 0, day: Math.min(15, Math.max(1, config.accountingSendDay || 5)), time: '09:00', whenOpen: 'wait', files: { salesTax: true, wht: true, zip: false } };
    if (!row) return { ...base, source: 'env', updatedAt: null, updatedBy: null };
    const v = row.value as Partial<AccountingSettings>;
    const [by] = row.updatedBy ? await this.db.select({ name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, row.updatedBy)) : [];
    return { ...base, ...v, files: { ...base.files, ...(v.files ?? {}) }, source: 'saved', updatedAt: row.updatedAt, updatedBy: by?.name ?? null };
  }

  async saveSettings(staff: Staff, input: AccountingSettings) {
    const value = { ...input, recipients: [...new Set(input.recipients)] };
    await this.db.insert(s.opsSettings).values({ key: 'accounting', value, updatedBy: staff.id }).onConflictDoUpdate({ target: s.opsSettings.key, set: { value, updatedBy: staff.id, updatedAt: new Date() } });
    await staffAudit(this.db, staff, 'ops.accounting_settings', `ตั้งค่าการส่งสำนักงานบัญชี · ${value.auto ? `อัตโนมัติวันที่ ${value.day} เวลา ${value.time}` : 'ปิดส่งอัตโนมัติ'} · ${value.whenOpen === 'wait' ? 'รอปิดงวด' : 'ส่งฉบับร่าง'} · ถึง ${value.recipients.join(', ') || '-'}`);
    return this.settings();
  }

  private typesOf(set: AccountingSettings): ExportType[] {
    return [...(set.files.salesTax ? ['sales_tax' as const] : []), ...(set.files.wht ? ['wht' as const] : []), ...(set.files.zip ? ['zip' as const] : [])];
  }

  // ---------------------------------------------------------------- ประวัติ (E5)

  /** ส่งอัตโนมัติครั้งถัดไป: วันที่ตั้งไว้ของเดือนนี้ (ถ้ายังไม่ถึง) หรือเดือนหน้า · ส่งไฟล์ของเดือนก่อนวันส่ง */
  nextAuto(set: AccountingSettings, at: Date = new Date()) {
    if (!set.auto || !set.recipients.length) return null;
    const now = bkkNow(at);
    const thisMonth = `${now.date.slice(0, 7)}-${String(set.day).padStart(2, '0')}`;
    let date = thisMonth;
    if (now.date > thisMonth || (now.date === thisMonth && now.time >= set.time)) {
      const d = new Date(`${now.date.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      date = `${d.toISOString().slice(0, 7)}-${String(set.day).padStart(2, '0')}`;
    }
    return { date, time: set.time, month: prevMonth(date) };
  }

  async delivery() {
    const set = await this.settings();
    const history = await this.rows<{ at: Date; action: string; reason: string; staffName: string | null; staffId: string | null }>(sql`
      select l.created_at as at, l.action, l.reason, st.name as "staffName", l.staff_id as "staffId" from staff_audit_logs l left join staff_users st on st.id = l.staff_id
      where l.action in ('billing.export_sent', 'billing.export_failed', 'billing.export_skipped')
        and left(l.reason, 7) in (select distinct left(reason, 7) from staff_audit_logs where action in ('billing.export_sent', 'billing.export_failed', 'billing.export_skipped') order by 1 desc limit 12)
      order by l.created_at desc limit 60`);
    const closed = await this.billing.closedMonths();
    return {
      settings: set,
      recipients: set.recipients,
      autoDay: set.day,
      next: this.nextAuto(set),
      closedMonths: [...closed].sort().reverse().slice(0, 24),
      history: history.map((h) => {
        const files = /ไฟล์ ([^·]+)/.exec(h.reason)?.[1]?.split(',').map((x) => x.trim()).filter(Boolean) ?? [...(h.reason.includes('รายงานภาษีขาย') ? ['PDF', 'Excel'] : []), ...(h.reason.includes('50 ทวิ') ? ['CSV'] : [])];
        return {
          at: h.at, month: h.reason.slice(0, 7), detail: h.reason, staffName: h.staffName, auto: !h.staffId,
          result: h.action === 'billing.export_sent' ? ('sent' as const) : h.action === 'billing.export_failed' ? ('failed' as const) : ('skipped' as const),
          draft: h.reason.includes('ฉบับร่าง'), files: h.action === 'billing.export_skipped' ? [] : files,
          error: h.action === 'billing.export_failed' ? (/ล้ม: (.+)$/.exec(h.reason)?.[1] ?? null) : null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- ไฟล์

  /** เอกสารภาษีทั้งเดือน (PDF ใน ZIP) · scope=all รวมรายงานภาษีขายและ 50 ทวิ CSV ("ดาวน์โหลดทั้งหมด") */
  async zip(q: z.infer<typeof ExportZipQuery>) {
    const [y, m] = q.month.split('-').map(Number);
    const draft = !(await this.billing.isClosed(q.month));
    const docs = await monthDocumentsZip(this.db, y, m, { vatRegistered: vatRegistered() });
    const suffix = draft ? '-draft' : '';
    if (q.scope === 'docs') return { buffer: docs.buffer, filename: `friday-tax-documents-${q.month}${suffix}.zip`, draft, files: docs.files };
    const [pdf, xlsx, csv] = await Promise.all([this.billing.salesReport({ month: q.month, format: 'pdf' }), this.billing.salesReport({ month: q.month, format: 'xlsx' }), this.billing.export({ month: q.month, type: 'wht' })]);
    const entries: ZipEntry[] = [
      { name: pdf.filename, data: pdf.buffer },
      { name: xlsx.filename, data: xlsx.buffer },
      { name: csv.filename, data: Buffer.from(csv.csv, 'utf8') },
      { name: `friday-tax-documents-${q.month}${suffix}.zip`, data: docs.buffer },
    ];
    return { buffer: zip(entries), filename: `friday-accounting-${q.month}${suffix}.zip`, draft, files: entries.length };
  }

  private async attachments(month: string, types: ExportType[]) {
    type Attachment = { filename: string; content: string | Buffer; contentType: string };
    const out: { type: ExportType; draft: boolean; rows: number; attachments: Attachment[] }[] = [];
    for (const type of types) {
      if (type === 'wht') {
        const f = await this.billing.export({ month, type: 'wht' });
        out.push({ type, draft: f.draft, rows: f.rows, attachments: [{ filename: f.filename, content: f.csv, contentType: 'text/csv; charset=utf-8' }] });
      } else if (type === 'zip') {
        const f = await this.zip({ month, scope: 'docs' });
        out.push({ type, draft: f.draft, rows: f.files, attachments: [{ filename: f.filename, content: f.buffer, contentType: 'application/zip' }] });
      } else {
        const [pdf, xlsx] = await Promise.all([this.billing.salesReport({ month, format: 'pdf' }), this.billing.salesReport({ month, format: 'xlsx' })]);
        out.push({ type, draft: pdf.draft, rows: pdf.rows, attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }, { filename: xlsx.filename, content: xlsx.buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- ส่ง

  /**
   * ส่งไฟล์ของงวดถึงสำนักงานบัญชี · งวดที่ยังไม่ปิดเป็นฉบับร่าง (หัวเรื่องและชื่อไฟล์บอก) · staff = null คืองานอัตโนมัติ
   * `to` = ทดลองส่ง (ไม่ลงประวัติ)
   */
  async sendExport(staff: Staff | null, input: z.infer<typeof SendExportBody>, opts: { to?: string[]; test?: boolean } = {}) {
    const set = await this.settings();
    const to = opts.to ?? set.recipients;
    if (!to.length) throw new AppError(409, 'accounting_email_not_set', 'ยังไม่ได้ตั้งอีเมลสำนักงานบัญชี (ตั้งค่าผู้รับและวันส่ง)');
    const types = input.types ?? this.typesOf(set);
    const files = await this.attachments(input.month, types);
    const draft = files.some((f) => f.draft);
    const fileLabels = types.flatMap((t) => FILE_LABEL[t]);
    const subject = `${opts.test ? '[ทดลองส่ง] ' : ''}Friday Work Management · ไฟล์บัญชีงวด ${input.month}${draft ? ' (ฉบับร่าง ยังไม่ปิดงวด)' : ''}`;
    const text = [
      `ไฟล์ประกอบการบันทึกบัญชีงวด ${input.month}${draft ? ' · ฉบับร่าง: งวดนี้ยังไม่ปิด ตัวเลขอาจเปลี่ยน · จะส่งฉบับจริงอีกครั้งเมื่อปิดงวด' : ''}`,
      ...files.map((f) => `- ${TYPE_LABEL[f.type]}: ${f.rows} รายการ (${f.attachments.map((a) => a.filename).join(', ')})`),
      'จำนวนเงินเป็นบาท · รายงานภาษีขายมี PDF (หน้า 1 ตามแบบ · หน้า 2 รายละเอียด) และ Excel (2 แท็บ) · 50 ทวิ เป็น CSV (UTF-8) · ZIP มีใบกำกับภาษี ใบลดหนี้ ใบเพิ่มหนี้เป็น PDF',
    ].join('\n');
    const attachments = files.flatMap((f) => f.attachments);
    let sent = 0;
    let lastError = '';
    for (const t of to) {
      try {
        await this.mail.send({ to: t, subject, text, attachments });
        sent++;
      } catch (e) {
        lastError = String((e as Error)?.message ?? e).slice(0, 200);
        this.log.error(`ส่งไฟล์บัญชีถึง ${t} ไม่สำเร็จ: ${lastError}`);
      }
    }
    const summary = `${input.month} · ไฟล์ ${fileLabels.join(', ')}${draft ? ' · ฉบับร่าง' : ''} · ถึง ${to.join(', ')}${staff ? '' : ' · อัตโนมัติ'}`;
    if (opts.test) {
      if (!sent) throw new AppError(502, 'mail_failed', 'ส่งอีเมลไม่สำเร็จ ลองใหม่อีกครั้ง');
      await staffAudit(this.db, staff, 'billing.export_test', summary);
      return { month: input.month, to, sent, draft, test: true, files: files.map((f) => ({ type: f.type, rows: f.rows, filenames: f.attachments.map((a) => a.filename) })) };
    }
    if (!sent) {
      await staffAudit(this.db, staff, 'billing.export_failed', `${summary} · ล้ม: ${lastError || 'ส่งอีเมลไม่สำเร็จ'}`);
      await this.push.toRoles(['finance'], { title: 'ส่งไฟล์ให้สำนักงานบัญชีไม่สำเร็จ', body: `งวด ${input.month} · ${lastError}`.slice(0, 160), url: '/payments?tab=revenue', tag: `accounting-${input.month}` }).catch(() => 0);
      throw new AppError(502, 'mail_failed', 'ส่งอีเมลไม่สำเร็จ ลองใหม่อีกครั้ง', { error: lastError });
    }
    await staffAudit(this.db, staff, 'billing.export_sent', summary);
    return { month: input.month, to, sent, draft, files: files.map((f) => ({ type: f.type, rows: f.rows, filenames: f.attachments.map((a) => a.filename) })) };
  }

  /** ทดลองส่งถึงอีเมลของฉัน (ไฟล์ของเดือนก่อน ตามไฟล์ที่ตั้งไว้) */
  async test(staff: Staff, types?: ExportType[]) {
    return this.sendExport(staff, { month: prevMonth(todayBkk()), types }, { to: [staff.email], test: true });
  }

  /**
   * งานรายชั่วโมง: ตั้งแต่วันและเวลาที่ตั้งไว้ ส่งไฟล์ของเดือนก่อน (ครั้งเดียว · ส่งเองแล้วก็ไม่ส่งซ้ำ)
   * งวดยังไม่ปิด: รอปิด (บันทึก "ไม่ได้ส่ง" ครั้งเดียว + แจ้งการเงินวันละครั้ง แล้วส่งทันทีที่ปิด) หรือส่งฉบับร่างแล้วส่งฉบับจริงเมื่อปิด
   */
  async autoSendExport(at: string | Date = new Date()) {
    const set = await this.settings();
    if (!set.auto || !set.recipients.length) return null;
    const now = bkkNow(at);
    const day = Number(now.date.slice(8, 10));
    if (day < set.day || (day === set.day && now.time < set.time)) return null;
    const month = prevMonth(now.date);
    const done = await this.rows<{ reason: string }>(sql`select reason from staff_audit_logs where action in ('billing.export_sent', 'billing.export_skipped') and left(reason, 7) = ${month}`);
    const final = done.some((d) => !d.reason.includes('ฉบับร่าง') && !d.reason.includes('ไม่ได้ส่ง'));
    if (final) return null;
    const closed = await this.billing.isClosed(month);
    const types = this.typesOf(set);
    if (closed) return this.sendExport(null, { month, types });
    if (set.whenOpen === 'draft') {
      if (done.some((d) => d.reason.includes('ฉบับร่าง'))) return null;
      return this.sendExport(null, { month, types });
    }
    if (!done.some((d) => d.reason.includes('ไม่ได้ส่ง'))) await staffAudit(this.db, null, 'billing.export_skipped', `${month} · ไม่ได้ส่ง · งวดยังไม่ปิด (รอปิดงวดแล้วส่งทันที)`);
    await this.push.once(`accounting-wait:${month}:${now.date}`, () => this.push.toRoles(['finance'], { title: 'รอปิดงวดเพื่อส่งสำนักงานบัญชี', body: `งวด ${month} ยังไม่ปิด · ระบบจะส่งไฟล์ให้สำนักงานบัญชีทันทีที่ปิดงวด`, url: '/payments?tab=revenue', tag: `accounting-wait-${month}` }));
    return { month, skipped: true as const };
  }
}
