import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PLAN_CATALOG, PLAN_ORDER, TRIAL_DAYS, YEARLY_MONTHS, priceFor } from '../billing/catalog.js';
import { APP_DB } from '../db/db.module.js';

const s = schema;

export const LEGAL_TYPES = ['terms', 'privacy', 'dpa', 'cookie', 'subprocessors'] as const;
export const LegalType = z.enum(LEGAL_TYPES);
export const LegalQuery = z.object({ locale: z.enum(['th', 'en']).default('th'), version: z.string().trim().min(1).max(20).optional() });
export const AcceptBody = z
  .object({
    /** รับทราบเอกสารฉบับที่ระบุ (id จาก GET public/legal/{type}) หรือระบุ type + version */
    documentId: z.uuid().optional(),
    type: LegalType.optional(),
    version: z.string().trim().min(1).max(20).optional(),
    locale: z.enum(['th', 'en']).default('th'),
    /** รับทราบในนาม Workspace นี้ (เช่น DPA) · ไม่ส่ง = ระดับบัญชี */
    workspace: z.string().trim().min(1).max(63).optional(),
  })
  .refine((v) => !!v.documentId || (!!v.type && !!v.version), { message: 'ระบุ documentId หรือ type พร้อม version' });

/** ฟีเจอร์ตามแพ็กเกจ (Landing › เปรียบเทียบแพ็กเกจ) · ทุกแพ็กเกจ Team ฟีเจอร์เท่ากัน */
const FREE_FEATURES = ['kanban', 'table', 'calendar', 'notifications_in_app', 'notifications_email'] as const;
const TEAM_FEATURES = [...FREE_FEATURES, 'gantt', 'workload', 'sprints', 'reports', 'import_excel', 'automation', 'line_oa', 'webhooks', 'git_integration'] as const;
const featuresOf = (code: string) => (code === 'free' ? FREE_FEATURES : TEAM_FEATURES);

type Doc = typeof s.legalDocuments.$inferSelect;
const docDto = (d: Doc) => ({ id: d.id, type: d.docType, version: d.version, locale: d.locale, effectiveAt: d.effectiveAt, summary: d.summary });

/** R1 · ราคา และ R4 · กฎหมาย */
@Injectable()
export class PublicService {
  constructor(
    @Inject(APP_DB) private readonly appDb: Db,
    private readonly db: TenantDb,
  ) {}

  /** ราคาแพ็กเกจ · ค่าในตาราง plans (ทีม Friday ตั้ง) ชนะค่าตั้งต้นใน billing/catalog.ts · ไม่รวม VAT 7% */
  async plans() {
    // plans อ่านได้โดยไม่ต้องมี Workspace (policy public_read) จึงใช้การเชื่อมต่อของแอปตรง ๆ
    const rows = await this.appDb.select().from(s.plans);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    return {
      currency: 'THB',
      vatRate: 0.07,
      vatIncluded: false,
      trialDays: TRIAL_DAYS,
      yearlyMonths: YEARLY_MONTHS,
      items: PLAN_ORDER.map((code) => {
        const spec = PLAN_CATALOG[code];
        const row = byCode.get(code);
        const price = { monthly: row?.priceMonthlySatang ?? null, yearly: row?.priceYearlySatang ?? null };
        return {
          code,
          // ชื่อที่แสดงตั้งได้ในหลังบ้าน (O20 · P1)
          name: row?.displayName ?? spec.name,
          seatLimit: row?.seatLimit ?? spec.seats,
          // Guest (ลูกค้า) ไม่นับเป็นที่นั่ง
          guestsFree: true,
          projectLimit: spec.projects,
          storageGbPerMember: row?.storageGbPerMember ?? spec.storageGbPerMember,
          // ราคาเป็นสตางค์ · null = ฟรี (Free) หรือติดต่อฝ่ายขาย (Enterprise)
          priceMonthlySatang: code === 'free' ? 0 : code === 'enterprise' ? null : priceFor(spec, 'monthly', price),
          priceYearlySatang: code === 'free' ? 0 : code === 'enterprise' ? null : priceFor(spec, 'yearly', price),
          contactSales: code === 'enterprise',
          // O20: ซ่อนจากหน้าราคา / ปิดรับสมัครใหม่ (ลูกค้าเดิมยังจ่ายต่อได้)
          listed: row?.listed ?? true,
          openForSignup: row?.openForSignup ?? true,
          features: featuresOf(code),
        };
      }),
    };
  }

  /** เอกสารฉบับที่มีผลแล้วและใหม่ที่สุดของแต่ละชนิด */
  async legalIndex(locale: 'th' | 'en') {
    const out = [];
    for (const type of LEGAL_TYPES) {
      const [d] = await this.latest(type, locale);
      if (d) out.push(docDto(d));
    }
    return { items: out };
  }

  private latest(type: string, locale: string, version?: string) {
    return this.appDb
      .select()
      .from(s.legalDocuments)
      .where(and(eq(s.legalDocuments.docType, type), eq(s.legalDocuments.locale, locale), lte(s.legalDocuments.effectiveAt, new Date()), version ? eq(s.legalDocuments.version, version) : undefined))
      .orderBy(desc(s.legalDocuments.effectiveAt), desc(s.legalDocuments.version))
      .limit(1);
  }

  /** ฉบับล่าสุด (หรือ `?version=`) พร้อมประวัติเวอร์ชัน */
  async legal(type: z.infer<typeof LegalType>, q: z.infer<typeof LegalQuery>) {
    const [d] = await this.latest(type, q.locale, q.version);
    if (!d) throw new AppError(404, 'legal_document_not_found', 'ยังไม่มีเอกสารนี้ในภาษาที่เลือก', { type, locale: q.locale });
    const history = await this.appDb
      .select({ version: s.legalDocuments.version, effectiveAt: s.legalDocuments.effectiveAt })
      .from(s.legalDocuments)
      .where(and(eq(s.legalDocuments.docType, type), eq(s.legalDocuments.locale, q.locale), lte(s.legalDocuments.effectiveAt, new Date())))
      .orderBy(desc(s.legalDocuments.effectiveAt));
    return { ...docDto(d), body: d.body, versions: history };
  }

  // ---------------------------------------------------------------------------
  // me/legal-acceptances
  // ---------------------------------------------------------------------------
  /** รับทราบเอกสาร · ซ้ำคือรับทราบแล้ว (ตอบ 200 ไม่เปลี่ยนเวลาเดิม) */
  async accept(auth: AuthInfo, body: z.infer<typeof AcceptBody>, ip: string | null) {
    const tenant = body.workspace ? await this.db.tenant(auth, body.workspace) : null;
    const [doc] = body.documentId
      ? await this.appDb.select().from(s.legalDocuments).where(eq(s.legalDocuments.id, body.documentId))
      : await this.latest(body.type!, body.locale, body.version);
    // ฉบับที่ยังไม่มีผล (effective_at ในอนาคต) รับทราบไม่ได้
    if (!doc || doc.effectiveAt.getTime() > Date.now()) throw notFound('เอกสาร');
    return this.db.run(auth, tenant, async (tx) => {
      const inserted = await tx
        .insert(s.legalAcceptances)
        .values({ userId: auth.userId, workspaceId: tenant?.workspaceId ?? null, documentId: doc.id, ip })
        .onConflictDoNothing()
        .returning();
      const [row] = inserted.length
        ? inserted
        : await tx
            .select()
            .from(s.legalAcceptances)
            .where(and(eq(s.legalAcceptances.userId, auth.userId), eq(s.legalAcceptances.documentId, doc.id)));
      return { alreadyAccepted: !inserted.length, document: docDto(doc), acceptedAt: row?.acceptedAt ?? null, workspace: tenant?.slug ?? null };
    });
  }

  /** เอกสารล่าสุดของแต่ละชนิดและฉันรับทราบแล้วหรือยัง (ใช้ขึ้นแบนเนอร์ "ข้อกำหนดเปลี่ยน") */
  async myAcceptances(auth: AuthInfo, locale: 'th' | 'en') {
    const index = await this.legalIndex(locale);
    const mine = await this.db.run(auth, null, (tx) => tx.select({ documentId: s.legalAcceptances.documentId, acceptedAt: s.legalAcceptances.acceptedAt }).from(s.legalAcceptances).where(eq(s.legalAcceptances.userId, auth.userId)));
    const at = new Map(mine.map((m) => [m.documentId, m.acceptedAt]));
    return { items: index.items.map((d) => ({ ...d, accepted: at.has(d.id), acceptedAt: at.get(d.id) ?? null })) };
  }
}
