import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { audit, staffAudit } from '../audit.js';
import { has, type OpsRequest, type Staff } from '../auth/auth.guard.js';
import { config } from '../config.js';
import { OPS_DB } from '../db.js';
import { AppError } from '../errors.js';
import { Mailer } from '../mail.js';
import { SupportSettingsService } from '../support/settings.service.js';
import { TicketsService } from '../support/tickets.service.js';
import { decrypt, encrypt, FmClient, type FmIssue, verifySignature } from './fm-client.js';

const s = schema;
const L = s.devIssueLinks;
const T = s.devIssueTickets;
type Row = Record<string, unknown>;
type Link = typeof L.$inferSelect;
const rowsOf = <T = Row>(r: unknown) => ((r as { rows?: unknown[] }).rows ?? (r as unknown[])) as T[];

const Severity = z.enum(s.DEV_SEVERITIES);
const Priority = z.enum(['urgent', 'high', 'medium', 'low']);
const IssueKey = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/, 'รูปแบบเลขงานไม่ถูกต้อง เช่น FM-482');
export const Mapping = z
  .object({
    severityPriority: z.object({ S1: Priority, S2: Priority, S3: Priority, S4: Priority }).strict(),
    /** สถานะหมวด Done ที่แปลว่า "ขึ้น production แล้ว" (ทีมพัฒนาเพิ่มใน workflow ของโปรเจกต์ FM) */
    releasedStatus: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(60),
    issueType: z.literal('Bug').default('Bug'),
  })
  .strict();
type MappingT = z.infer<typeof Mapping>;
const DEFAULT_MAPPING: MappingT = { severityPriority: { S1: 'urgent', S2: 'high', S3: 'medium', S4: 'low' }, releasedStatus: 'Released', label: 'from-support', issueType: 'Bug' };

export const SettingsBody = z
  .object({
    /** URL ภายในเครือข่าย เช่น http://api:3001 */
    apiBaseUrl: z.url({ protocol: /^https?$/ }).max(300),
    workspaceSlug: z.string().trim().min(2).max(63),
    projectKey: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/),
    /** ไม่ส่ง = ใช้ค่าเดิม · เปลี่ยนต้องแตะ Security key (G4) */
    token: z.string().trim().min(10).max(500).optional(),
    tokenExpiresAt: z.iso.date().nullable().optional(),
    webhookSecret: z.string().trim().min(16).max(200).optional(),
    mapping: Mapping.optional(),
  })
  .strict();
export const EscalateBody = z
  .object({
    mode: z.enum(['create', 'link']),
    severity: Severity,
    /** create: หัวข้องานใน FM · link: ไม่ใช้ */
    title: z.string().trim().min(5).max(300).optional(),
    steps: z.string().trim().min(10).max(5000),
    expected: z.string().trim().max(1000).optional(),
    affected: z.string().trim().max(200).optional(),
    requestId: z.string().trim().max(80).optional(),
    /** ไม่ส่ง = ตามการจับคู่ความรุนแรง */
    priority: Priority.optional(),
    issueKey: IssueKey.optional(),
    notifyCustomer: z.boolean().default(true),
  })
  .strict()
  .refine((b) => (b.mode === 'create' ? !!b.title : !!b.issueKey), { message: 'สร้างงานใหม่ต้องมีหัวข้อ · ผูกงานเดิมต้องเลือกงาน', path: ['mode'] });
export const LinkBody = z.object({ issueKey: IssueKey, severity: Severity.optional() }).strict();
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200), similar: z.stringbool().default(false) });
export const LinksQuery = z.object({ filter: z.enum(['open', 'to_notify', 'not_fixed', 'closed30', 'all']).default('open') });
export const NotifyBody = z
  .object({
    message: z.string().trim().min(10).max(5000),
    /** เปลี่ยน Ticket เป็น "แก้แล้ว" (ลูกค้าตอบใน 7 วันเปิดใหม่อัตโนมัติ) */
    solve: z.boolean().default(true),
    csat: z.boolean().default(true),
    /** ร่างรายการ "แก้ไข" ใน Changelog (O33 · U4) */
    changelog: z.boolean().default(false),
  })
  .strict();
export const ResolveBody = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('link_fixed'), targetKey: IssueKey }).strict(),
    z.object({ action: z.literal('workaround'), message: z.string().trim().min(10).max(5000) }).strict(),
    z.object({ action: z.literal('return'), note: z.string().trim().max(1000).optional() }).strict(),
  ]);

/** รหัส Workspace ที่ทีมพัฒนาเห็นแทนชื่อลูกค้า (เช่น ws_3b07) */
export const wsCode = (id: string | null) => (id ? `ws_${id.replace(/-/g, '').slice(-4)}` : 'ws_none');
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{([^}]+)\}/g, (m, k: string) => v[k] ?? m);
const DEFAULT_MESSAGE = 'สวัสดีครับ คุณ{ชื่อผู้แจ้ง}\nปัญหาที่แจ้งใน #{เลข Ticket} "{หัวข้อ}" แก้แล้วและใช้งานได้ตั้งแต่วันนี้\nถ้ายังพบปัญหา ตอบกลับข้อความนี้ได้เลย เราจะเปิดเรื่องต่อให้ทันที';

/**
 * O36 · ส่งบั๊กจาก Ticket ให้ทีมพัฒนาเป็นงานในโปรเจกต์ FM ของ Friday Manage เอง (บอร์ด 20 · T3 · T7–T11)
 * คุยกับ API ลูกค้าผ่าน API token (A28) เหมือนระบบภายนอก · รับสถานะกลับผ่าน Webhook (A25) ที่ตรวจลายเซ็น + ดึงสำรองทุก 15 นาที
 * ทีมพัฒนาเห็นเลข Ticket และรหัส Workspace เท่านั้น ไม่เห็นอีเมล / ชื่อลูกค้า
 */
@Injectable()
export class DevBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DevBridge');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(OPS_DB) private readonly db: Db,
    private readonly tickets: TicketsService,
    private readonly support: SupportSettingsService,
    private readonly mail: Mailer,
  ) {}

  onModuleInit() {
    // ดึงสถานะสำรองทุก 15 นาที เผื่อ Webhook หาย (คำตัดสิน O36) · test เรียก poll() เอง
    if (!process.env.VITEST && process.env.OPS_JOBS !== 'off') {
      this.timer = setInterval(() => void this.poll().catch((e) => this.log.error(String(e))), 15 * 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async rows<R = Row>(q: SQL) {
    return rowsOf<R>(await this.db.execute(q));
  }

  // ── การเชื่อมต่อ (T11) ─────────────────────────────────

  private async settingsRow() {
    const [r] = await this.db.select().from(s.devBridgeSettings).where(eq(s.devBridgeSettings.id, 1));
    return r ?? null;
  }
  private mapping(r: { mapping: unknown } | null): MappingT {
    const ok = Mapping.safeParse(r?.mapping);
    return ok.success ? ok.data : DEFAULT_MAPPING;
  }

  /** client ของ FM · ยังไม่ตั้งค่า = 409 ให้ตั้งที่ T11 ก่อน */
  async client() {
    const r = await this.settingsRow();
    const token = decrypt(r?.tokenEnc ?? null);
    if (!r?.apiBaseUrl || !r.workspaceSlug || !r.projectKey || !token) throw new AppError(409, 'bridge_not_configured', 'ยังไม่ได้ตั้งค่าการเชื่อมต่อกับ Friday Manage ของทีมพัฒนา');
    return { fm: new FmClient({ apiBaseUrl: r.apiBaseUrl, workspaceSlug: r.workspaceSlug, projectKey: r.projectKey, token }), settings: r, mapping: this.mapping(r) };
  }

  private issueUrl(r: { workspaceSlug: string | null; projectKey: string | null }, key: string) {
    return r.workspaceSlug && r.projectKey ? `${config.appUrl}/work/${r.workspaceSlug}/p/${r.projectKey}?issue=${key}` : null;
  }

  async settings(staff: Staff) {
    const r = await this.settingsRow();
    return {
      configured: !!(r?.apiBaseUrl && r.workspaceSlug && r.projectKey && r.tokenEnc),
      apiBaseUrl: r?.apiBaseUrl ?? null,
      workspaceSlug: r?.workspaceSlug ?? null,
      projectKey: r?.projectKey ?? null,
      tokenHint: r?.tokenHint ?? null,
      tokenExpiresAt: r?.tokenExpiresAt ?? null,
      hasWebhookSecret: !!r?.webhookSecretEnc,
      webhookPath: '/ops/hooks/fm',
      mapping: this.mapping(r),
      lastWebhookAt: r?.lastWebhookAt ?? null,
      lastTestAt: r?.lastTestAt ?? null,
      lastTestOk: r?.lastTestOk ?? null,
      projectUrl: r?.workspaceSlug && r.projectKey ? `${config.appUrl}/work/${r.workspaceSlug}/p/${r.projectKey}` : null,
      canEdit: has(staff, 'owner', 'engineer'),
    };
  }

  /** บันทึกการเชื่อมต่อ · เปลี่ยน token / secret ต้องยืนยันตัวตนซ้ำด้วย Security key ภายใน 15 นาที */
  async saveSettings(req: OpsRequest, input: z.infer<typeof SettingsBody>) {
    const staff = req.staff!;
    if ((input.token || input.webhookSecret) && !req.reauthed) throw new AppError(401, 'reauth_required', 'แตะ Security key เพื่อยืนยันตัวตนก่อนเปลี่ยน token');
    const cur = await this.settingsRow();
    if (!input.token && !cur?.tokenEnc) throw new AppError(422, 'token_required', 'ใส่ API token ของบัญชีบอท');
    const values = {
      apiBaseUrl: input.apiBaseUrl.replace(/\/$/, ''), workspaceSlug: input.workspaceSlug, projectKey: input.projectKey,
      ...(input.token ? { tokenEnc: encrypt(input.token), tokenHint: `…${input.token.slice(-4)}` } : {}),
      ...(input.tokenExpiresAt !== undefined ? { tokenExpiresAt: input.tokenExpiresAt ? new Date(`${input.tokenExpiresAt}T00:00:00+07:00`) : null } : {}),
      ...(input.webhookSecret ? { webhookSecretEnc: encrypt(input.webhookSecret) } : {}),
      ...(input.mapping ? { mapping: input.mapping } : {}),
      updatedBy: staff.id,
    };
    await this.db.insert(s.devBridgeSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: s.devBridgeSettings.id, set: values });
    const what = [`${input.workspaceSlug} › ${input.projectKey}`, input.token ? 'เปลี่ยน API token' : '', input.webhookSecret ? 'เปลี่ยน Webhook secret' : '', input.mapping ? 'จับคู่ค่า' : ''].filter(Boolean).join(' · ');
    await staffAudit(this.db, staff, 'dev_bridge.settings_updated', `ตั้งค่าการเชื่อมต่อทีมพัฒนา · ${what}`);
    return this.settings(staff);
  }

  /** ปุ่มทดสอบ: token ใช้ได้ · เห็นโปรเจกต์ · มีสถานะ Released ใน workflow · มี / สร้าง Label ได้ */
  async test(staff: Staff) {
    const { fm, mapping } = await this.client();
    const checks: { key: string; ok: boolean; message: string }[] = [];
    const step = async (key: string, fn: () => Promise<string>) => {
      try {
        checks.push({ key, ok: true, message: await fn() });
        return true;
      } catch (e) {
        checks.push({ key, ok: false, message: (e as Error).message });
        return false;
      }
    };
    if (await step('token', async () => `บัญชีบอท: ${(await fm.me()).displayName}`)) {
      if (await step('project', async () => { const p = await fm.getProject(); return `${p.key} · ${p.name}`; })) {
        await step('released', async () => {
          const st = (await fm.statuses()).find((x) => x.name.toLowerCase() === mapping.releasedStatus.toLowerCase());
          if (!st) throw new Error(`ยังไม่มีสถานะ "${mapping.releasedStatus}" ใน workflow ของโปรเจกต์ · เพิ่มเป็นหมวด Done`);
          if (st.category !== 'done') throw new Error(`สถานะ "${st.name}" ต้องอยู่หมวด Done`);
          return `สถานะ ${st.name} (Done)`;
        });
        await step('label', async () => { await fm.labelId(mapping.label); return `Label ${mapping.label}`; });
      }
    }
    const ok = checks.every((c) => c.ok);
    await this.db.update(s.devBridgeSettings).set({ lastTestAt: new Date(), lastTestOk: ok }).where(eq(s.devBridgeSettings.id, 1));
    await staffAudit(this.db, staff, 'dev_bridge.tested', `ทดสอบการเชื่อมต่อทีมพัฒนา · ${ok ? 'ผ่าน' : 'ไม่ผ่าน'}`);
    return { ok, checks };
  }

  // ── ค้นงาน / ส่งต่อ / ผูก (T3 · T7) ───────────────────

  private async linkCounts(keys: string[]) {
    if (!keys.length) return new Map<string, number>();
    const r = await this.db.select({ key: L.issueKey, n: sql<number>`count(${T.ticketId})::int` }).from(L).leftJoin(T, eq(T.linkId, L.id)).where(inArray(L.issueKey, keys)).groupBy(L.issueKey);
    return new Map(r.map((x) => [x.key, x.n]));
  }

  /**
   * T7 ค้นงาน Bug ในโปรเจกต์ FM · similar=1 = หางานที่อาจซ้ำจากหัวข้อ Ticket (ค้นทีละคำยาว ๆ แล้วเรียงตามจำนวนคำที่ตรง)
   */
  async search(q: z.infer<typeof SearchQuery>) {
    const { fm, settings } = await this.client();
    let found: FmIssue[];
    if (q.similar) {
      const words = [...new Set(q.q.split(/[\s,.:;()"'/]+/).filter((w) => w.length >= 4))].sort((a, b) => b.length - a.length).slice(0, 3);
      const hits = new Map<string, { issue: FmIssue; n: number }>();
      for (const w of words) for (const i of await fm.searchBugs(w, 10)) hits.set(i.key, { issue: i, n: (hits.get(i.key)?.n ?? 0) + 1 });
      found = [...hits.values()].filter((h) => h.n >= Math.min(2, words.length)).sort((a, b) => b.n - a.n).map((h) => h.issue).slice(0, 5);
    } else {
      found = IssueKey.safeParse(q.q).success ? [await fm.getIssue(q.q.toUpperCase()).catch(() => null)].filter((x): x is FmIssue => !!x) : await fm.searchBugs(q.q, 10);
    }
    const counts = await this.linkCounts(found.map((i) => i.key));
    return { items: found.map((i) => ({ key: i.key, title: i.title, status: { name: i.status.name, category: i.status.category }, priority: i.priority, linkedTickets: counts.get(i.key) ?? 0, url: this.issueUrl(settings, i.key) })) };
  }

  /** สถานะล่าสุดจากงานใน FM → ค่าที่เก็บใน dev_issue_links */
  private snapshot(issue: FmIssue, mapping: MappingT, prev: Partial<Link> | null, names: { people: Map<string, string>; sprints: Map<string, string> }) {
    const now = new Date();
    const cat = issue.status.category;
    const released = cat === 'done' && issue.status.name.toLowerCase() === mapping.releasedStatus.toLowerCase();
    const cancelled = cat === 'cancelled';
    const dup = cancelled && /dup|ซ้ำ/i.test(issue.status.name);
    const dupOf = dup ? (new RegExp(`(?:ซ้ำ(?:กับ)?|duplicate(?:\\s+of)?)\\s*:?\\s*([A-Z][A-Z0-9]{1,9}-\\d+)`, 'i').exec(issue.description ?? '')?.[1]?.toUpperCase() ?? null) : null;
    return {
      title: issue.title,
      statusName: issue.status.name,
      statusCategory: cat,
      resolution: cancelled ? (dup ? 'duplicate' : 'wont_fix') : null,
      duplicateOfKey: dupOf,
      assigneeName: issue.assigneeIds.map((id) => names.people.get(id)).filter(Boolean)[0] ?? null,
      sprintName: issue.sprintId ? (names.sprints.get(issue.sprintId) ?? null) : null,
      dueDate: issue.planEnd,
      doneAt: cat === 'done' ? (prev?.doneAt ?? now) : null,
      releasedAt: released ? (prev?.releasedAt ?? now) : null,
      syncedAt: now,
    };
  }

  /** บันทึกภายในของ Ticket (ข้อความระบบที่ลูกค้าไม่เห็น · author staff ไม่มีชื่อ) */
  private async internalNote(ticketIds: string[], body: string) {
    if (ticketIds.length) await this.db.insert(s.supportTicketMessages).values(ticketIds.map((ticketId) => ({ ticketId, authorKind: 'staff', internal: true, body })));
  }

  private async attach(staff: Staff, ticketId: string, link: Link) {
    const [prev] = await this.db.select().from(T).where(eq(T.ticketId, ticketId));
    await this.db
      .insert(T)
      .values({ ticketId, linkId: link.id, linkedBy: staff.id })
      .onConflictDoUpdate({ target: T.ticketId, set: { linkId: link.id, linkedBy: staff.id, linkedAt: new Date(), notifiedAt: null, notifiedBy: null, outcome: null } });
    return prev ?? null;
  }

  private async upsertLink(staff: Staff, issue: FmIssue, severity: string, mapping: MappingT, fm: FmClient) {
    const [cur] = await this.db.select().from(L).where(eq(L.issueKey, issue.key));
    const snap = this.snapshot(issue, mapping, cur ?? null, await fm.names());
    if (cur) {
      const [r] = await this.db.update(L).set(snap).where(eq(L.id, cur.id)).returning();
      return r;
    }
    const [r] = await this.db.insert(L).values({ issueKey: issue.key, issueId: null, severity, createdBy: staff.id, ...snap }).returning();
    return r;
  }

  private async ticketRow(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    const [t] = await this.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
    if (!t) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    if (t.status === 'closed' || t.status === 'solved') throw new AppError(409, 'ticket_solved', 'Ticket นี้ปิดเรื่องแล้ว');
    return t;
  }

  /**
   * T3 (ปรับ): สร้างงาน Bug ใหม่ใน FM หรือผูกกับงานเดิม แล้วส่งต่อตามขั้นตอนเดิม (pending_dev · บันทึกภายใน · แจ้งลูกค้า)
   * เรียก FM ก่อนแก้ข้อมูลของเรา: FM ล้ม = Ticket ไม่เปลี่ยน
   */
  async escalate(staff: Staff, ticketId: string, input: z.infer<typeof EscalateBody>) {
    const t = await this.ticketRow(ticketId);
    const { fm, settings, mapping } = await this.client();
    const code = wsCode(t.workspaceId);
    const ticketUrl = `${config.origin}/support?ticket=${t.id}`;
    let issue: FmIssue;
    if (input.mode === 'create') {
      const description = [
        `**มาจาก Support** · ความรุนแรง ${input.severity} · Ticket #${t.number} (${code})`,
        '',
        '**ขั้นตอนทำซ้ำ**',
        input.steps,
        ...(input.expected ? ['', `**ผลที่ควรเป็น** ${input.expected}`] : []),
        ...(input.affected ? ['', `**ลูกค้าที่กระทบ** ${input.affected}`] : []),
        ...(input.requestId ? ['', `**requestId** ${input.requestId}`] : []),
        '',
        `เปิด Ticket ใน Friday Ops (เฉพาะพนักงาน): ${ticketUrl}`,
      ].join('\n');
      issue = await fm.createBug({ title: input.title!, description, priority: input.priority ?? mapping.severityPriority[input.severity], labelIds: [await fm.labelId(mapping.label)] });
    } else {
      issue = await fm.getIssue(input.issueKey!);
      await fm.comment(issue.key, `Ticket #${t.number} (${code}) ผูกเพิ่มจาก Support · ความรุนแรง ${input.severity}${input.requestId ? ` · requestId ${input.requestId}` : ''}`);
    }
    const link = await this.upsertLink(staff, issue, input.severity, mapping, fm);
    await this.attach(staff, t.id, link);
    await this.tickets.escalate(staff, t.id, { severity: input.severity, steps: input.steps, affected: input.affected, requestId: input.requestId, notifyCustomer: input.notifyCustomer, devIssueKey: issue.key });
    await this.trace(staff, t, input.mode === 'create' ? 'dev.issue_created' : 'dev.issue_linked', `${input.mode === 'create' ? 'สร้างงาน' : 'ผูกกับงาน'} ${issue.key} ให้ทีมพัฒนา · ${input.severity}`);
    return { link: await this.linkDto(link, settings), ticketId: t.id, status: 'pending_dev' as const };
  }

  /** T7 จากการ์ด T8: เปลี่ยนงานที่ผูก (Ticket ที่ส่งต่อแล้ว) */
  async relink(staff: Staff, ticketId: string, input: z.infer<typeof LinkBody>) {
    const t = await this.ticketRow(ticketId);
    const { fm, settings, mapping } = await this.client();
    const issue = await fm.getIssue(input.issueKey);
    const [prev] = await this.db.select({ severity: L.severity }).from(T).innerJoin(L, eq(L.id, T.linkId)).where(eq(T.ticketId, t.id));
    const severity = input.severity ?? prev?.severity ?? 'S3';
    await fm.comment(issue.key, `Ticket #${t.number} (${wsCode(t.workspaceId)}) ผูกเพิ่มจาก Support · ความรุนแรง ${severity}`);
    const link = await this.upsertLink(staff, issue, severity, mapping, fm);
    await this.attach(staff, t.id, link);
    await this.internalNote([t.id], `ผูกกับงาน ${issue.key} ของทีมพัฒนา`);
    if (t.status !== 'pending_dev') await this.db.update(s.supportTickets).set({ status: 'pending_dev', updatedAt: new Date() }).where(eq(s.supportTickets.id, t.id));
    await this.trace(staff, t, 'dev.issue_linked', `ผูกกับงาน ${issue.key} ให้ทีมพัฒนา`);
    return { link: await this.linkDto(link, settings) };
  }

  /** ยกเลิกการผูก: Ticket กลับเป็น "รอทีมตอบ" ให้ Support ดูต่อ */
  async unlink(staff: Staff, ticketId: string) {
    const [x] = await this.db.select({ t: s.supportTickets, key: L.issueKey }).from(T).innerJoin(L, eq(L.id, T.linkId)).innerJoin(s.supportTickets, eq(s.supportTickets.id, T.ticketId)).where(eq(T.ticketId, ticketId));
    if (!x) throw new AppError(404, 'not_linked', 'Ticket นี้ยังไม่ได้ผูกกับงานของทีมพัฒนา');
    await this.db.transaction(async (tx) => {
      await tx.delete(T).where(eq(T.ticketId, ticketId));
      if (x.t.status === 'pending_dev') await tx.update(s.supportTickets).set({ status: 'open', updatedAt: new Date() }).where(eq(s.supportTickets.id, ticketId));
      await tx.insert(s.supportTicketMessages).values({ ticketId, authorKind: 'staff', authorStaffId: staff.id, internal: true, body: `ยกเลิกการผูกกับ ${x.key}` });
    });
    await this.trace(staff, x.t, 'dev.issue_unlinked', `ยกเลิกการผูกกับ ${x.key}`);
    return { ticketId, linked: false };
  }

  private async trace(staff: Staff, t: { id: string; number: number; workspaceId: string | null }, action: string, summary: string) {
    if (t.workspaceId) await audit(this.db, staff, t.workspaceId, 'data', action, `#${t.number} · ${summary}`, { type: 'support_ticket', id: t.id });
    else await staffAudit(this.db, staff, action, `#${t.number} · ${summary}`, { type: 'support_ticket', id: t.id });
  }

  // ── การ์ด T8 · หน้า 20 ──────────────────────────────────

  private async linkDto(link: Link, settings: { workspaceSlug: string | null; projectKey: string | null } | null) {
    const tickets = await this.rows<{ id: string; number: number; status: string; workspace: string | null; notifiedAt: Date | null; outcome: string | null }>(sql`
      select k.id, k.number, k.status, w.name as workspace, t.notified_at as "notifiedAt", t.outcome
      from dev_issue_tickets t join support_tickets k on k.id = t.ticket_id left join workspaces w on w.id = k.workspace_id
      where t.link_id = ${link.id} order by k.number`);
    return {
      id: link.id, issueKey: link.issueKey, title: link.title, severity: link.severity, statusName: link.statusName, statusCategory: link.statusCategory,
      resolution: link.resolution, duplicateOfKey: link.duplicateOfKey, assigneeName: link.assigneeName, sprintName: link.sprintName, dueDate: link.dueDate,
      doneAt: link.doneAt, releasedAt: link.releasedAt, releaseVersion: link.releaseVersion, syncedAt: link.syncedAt, createdAt: link.createdAt,
      url: settings ? this.issueUrl(settings, link.issueKey) : null,
      tickets, unnotified: tickets.filter((x) => !x.notifiedAt && x.outcome !== 'returned').length,
    };
  }

  async forTicket(ticketId: string) {
    if (!z.uuid().safeParse(ticketId).success) throw new AppError(404, 'not_found', 'ไม่พบ Ticket');
    const [x] = await this.db.select({ link: L }).from(T).innerJoin(L, eq(L.id, T.linkId)).where(eq(T.ticketId, ticketId));
    const settings = await this.settingsRow();
    return { link: x ? await this.linkDto(x.link, settings) : null, configured: !!settings?.tokenEnc };
  }

  /** หน้า 20 · KPI + แถบ "ขึ้น production แล้ว ยังไม่แจ้ง" + การเชื่อมต่อ · วิศวกรเห็นชื่อ Workspace แต่ไม่เห็นอีเมล / ยอดเงิน */
  async overview(staff: Staff) {
    const [k] = await this.rows<Row>(sql`
      select
        count(*) filter (where l.status_category is distinct from 'done' and l.resolution is null)::int as "openBugs",
        count(*) filter (where l.status_category is distinct from 'done' and l.resolution is null and l.severity = 'S1')::int as s1,
        count(*) filter (where l.status_category is distinct from 'done' and l.resolution is null and l.severity = 'S2')::int as s2,
        count(*) filter (where l.status_category is distinct from 'done' and l.resolution is null and l.severity = 'S3')::int as s3,
        count(*) filter (where l.status_category is distinct from 'done' and l.resolution is null and l.severity = 'S4')::int as s4,
        round(avg(extract(epoch from l.done_at - l.created_at) / 86400) filter (where l.severity = 'S2' and l.done_at > now() - interval '90 days')::numeric, 1)::float8 as "avgFixDaysS2"
      from dev_issue_links l`);
    const [w] = await this.rows<{ tickets: number; workspaces: number }>(sql`
      select count(*)::int as tickets, count(distinct workspace_id)::int as workspaces from support_tickets where status = 'pending_dev'`);
    const pending = await this.rows<{ id: string; issueKey: string; releasedAt: Date; doneAt: Date; n: number }>(sql`
      select l.id, l.issue_key as "issueKey", l.released_at as "releasedAt", l.done_at as "doneAt", count(*)::int as n
      from dev_issue_links l join dev_issue_tickets t on t.link_id = l.id
      where l.status_category = 'done' and t.notified_at is null and (t.outcome is null or t.outcome <> 'returned')
      group by l.id order by l.released_at desc nulls last, l.done_at desc`);
    const set = await this.settings(staff);
    return {
      kpi: { openBugs: k?.openBugs ?? 0, bySeverity: { S1: k?.s1 ?? 0, S2: k?.s2 ?? 0, S3: k?.s3 ?? 0, S4: k?.s4 ?? 0 }, ticketsWaiting: w?.tickets ?? 0, workspaces: w?.workspaces ?? 0, avgFixDaysS2: k?.avgFixDaysS2 ?? null, toNotify: pending.reduce((a, p) => a + p.n, 0), linksToNotify: pending.length },
      released: pending.filter((p) => p.releasedAt).map((p) => ({ linkId: p.id, issueKey: p.issueKey, releasedAt: p.releasedAt, tickets: p.n })),
      connection: set,
      canNotify: has(staff, 'support'),
    };
  }

  async links(q: z.infer<typeof LinksQuery>) {
    const where: Record<typeof q.filter, SQL> = {
      open: sql`l.status_category is distinct from 'done' and l.resolution is null`,
      to_notify: sql`l.status_category = 'done' and exists (select 1 from dev_issue_tickets t where t.link_id = l.id and t.notified_at is null and (t.outcome is null or t.outcome <> 'returned'))`,
      not_fixed: sql`l.resolution is not null and exists (select 1 from dev_issue_tickets t where t.link_id = l.id and t.notified_at is null and (t.outcome is null or t.outcome <> 'returned'))`,
      closed30: sql`(l.done_at > now() - interval '30 days' or (l.resolution is not null and l.updated_at > now() - interval '30 days'))`,
      all: sql`true`,
    };
    const items = await this.rows(sql`
      select l.id, l.issue_key as "issueKey", l.title, l.severity, l.status_name as "statusName", l.status_category as "statusCategory", l.resolution, l.duplicate_of_key as "duplicateOfKey",
        l.assignee_name as "assigneeName", l.sprint_name as "sprintName", l.due_date as "dueDate", l.done_at as "doneAt", l.released_at as "releasedAt", l.created_at as "createdAt",
        (select count(*) from dev_issue_tickets t where t.link_id = l.id)::int as tickets,
        (select count(*) from dev_issue_tickets t where t.link_id = l.id and t.notified_at is null and (t.outcome is null or t.outcome <> 'returned'))::int as unnotified,
        coalesce((select json_agg(distinct w.name) from dev_issue_tickets t join support_tickets k on k.id = t.ticket_id join workspaces w on w.id = k.workspace_id where t.link_id = l.id), '[]') as workspaces
      from dev_issue_links l where ${where[q.filter]}
      order by l.severity, (select count(*) from dev_issue_tickets t where t.link_id = l.id) desc, l.created_at desc limit 200`);
    const counts = await this.rows<Row>(sql`
      select ${sql.join((Object.keys(where) as (keyof typeof where)[]).filter((f) => f !== 'all').map((f) => sql`(select count(*) from dev_issue_links l where ${where[f]})::int as ${sql.identifier(f)}`), sql`, `)}`);
    return { items, counts: counts[0] };
  }

  // ── ซิงก์สถานะ (Webhook + ดึงสำรอง) ──────────────────────

  /** รับ Webhook ของโปรเจกต์ FM (ตรวจลายเซ็น) · ใช้เป็นสัญญาณให้ดึงสถานะจริงของงานที่ผูกไว้ */
  async hook(headers: Record<string, string | string[] | undefined>, body: unknown) {
    const r = await this.settingsRow();
    const secret = decrypt(r?.webhookSecretEnc ?? null);
    if (!secret) throw new AppError(401, 'webhook_not_configured', 'ยังไม่ได้ตั้ง Webhook secret');
    const raw = JSON.stringify(body ?? {});
    const h = (k: string) => (Array.isArray(headers[k]) ? (headers[k] as string[])[0] : (headers[k] as string | undefined));
    if (!verifySignature(secret, h('x-friday-timestamp'), h('x-friday-signature'), raw)) throw new AppError(401, 'bad_signature', 'ลายเซ็น Webhook ไม่ถูกต้อง');
    await this.db.update(s.devBridgeSettings).set({ lastWebhookAt: new Date() }).where(eq(s.devBridgeSettings.id, 1));
    const project = r?.projectKey ?? '';
    const keys = [...new Set([...raw.matchAll(new RegExp(`\\b${project}-\\d+\\b`, 'g'))].map((m) => m[0]))];
    if (!keys.length) return { ok: true, synced: 0 };
    const linked = await this.db.select().from(L).where(inArray(L.issueKey, keys));
    for (const l of linked) await this.sync(l).catch((e) => this.log.warn(`sync ${l.issueKey}: ${(e as Error).message}`));
    return { ok: true, synced: linked.length };
  }

  /** ดึงสถานะงานที่ยังไม่จบ / ยังมี Ticket รอแจ้ง ทุก 15 นาที (Webhook หายก็ยังตามทัน) */
  async poll() {
    const r = await this.settingsRow();
    if (!r?.tokenEnc) return { synced: 0 };
    const list = await this.db
      .select()
      .from(L)
      .where(sql`(${L.releasedAt} is null and ${L.resolution} is null) or exists (select 1 from dev_issue_tickets t where t.link_id = ${L.id} and t.notified_at is null)`);
    let n = 0;
    for (const l of list) {
      try {
        await this.sync(l);
        n++;
      } catch (e) {
        this.log.warn(`poll ${l.issueKey}: ${(e as Error).message}`);
      }
    }
    return { synced: n };
  }

  /** อัปเดต 1 งาน · สถานะเปลี่ยน = บันทึกภายในทุก Ticket ที่ผูก · ขึ้น production / ปิดแบบไม่แก้ = แจ้งหัวหน้าทีม Support */
  async sync(link: Link) {
    const { fm, mapping } = await this.client();
    const issue = await fm.getIssue(link.issueKey);
    const snap = this.snapshot(issue, mapping, link, await fm.names());
    await this.db.update(L).set(snap).where(eq(L.id, link.id));
    if (snap.statusName === link.statusName && snap.resolution === link.resolution) return { changed: false };
    const ticketRows = await this.db.select({ id: T.ticketId, notifiedAt: T.notifiedAt }).from(T).where(eq(T.linkId, link.id));
    const at = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
    const newlyReleased = !!snap.releasedAt && !link.releasedAt;
    await this.internalNote(ticketRows.map((x) => x.id), `ระบบ · ${link.issueKey} เปลี่ยนเป็น ${snap.statusName} ${at}${newlyReleased ? ' · ขึ้น production แล้ว' : ''}`);
    const waiting = ticketRows.filter((x) => !x.notifiedAt).length;
    if (waiting && (newlyReleased || (snap.resolution && !link.resolution))) {
      const what = newlyReleased ? 'ขึ้น production แล้ว · รอแจ้งลูกค้า' : `ทีมพัฒนาปิดแบบ${snap.resolution === 'duplicate' ? 'ซ้ำ' : 'ไม่แก้'}`;
      await this.support.notifyLeads(`[${link.issueKey}] ${what} ${waiting} ราย`, `${link.issueKey} ${snap.title}\n${what} (Ticket ที่ผูก ${waiting} ราย)\nเปิดหน้า "ส่งบั๊กให้ทีมพัฒนา" ใน Friday Ops เพื่อแจ้งลูกค้า`);
    }
    return { changed: true };
  }

  // ── แจ้งลูกค้า (T9) · ไม่แก้ / ซ้ำ (T10) ─────────────────

  private async findLink(id: string) {
    if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found', 'ไม่พบงาน');
    const [l] = await this.db.select().from(L).where(eq(L.id, id));
    if (!l) throw new AppError(404, 'not_found', 'ไม่พบงาน');
    return l;
  }

  private async waiting(linkId: string) {
    return this.rows<{ id: string; number: number; subject: string; status: string; workspaceId: string | null; workspace: string | null; slug: string | null; email: string | null; requester: string | null }>(sql`
      select k.id, k.number, k.subject, k.status, k.workspace_id as "workspaceId", w.name as workspace, w.slug, k.requester_email as email, u.display_name as requester
      from dev_issue_tickets t join support_tickets k on k.id = t.ticket_id left join workspaces w on w.id = k.workspace_id left join users u on u.id = k.requester_user_id
      where t.link_id = ${linkId} and t.notified_at is null and (t.outcome is null or t.outcome <> 'returned') and k.status <> 'closed'
      order by k.number`);
  }

  /** T9 ตัวอย่าง: ทุก Ticket ที่ผูกและยังไม่แจ้ง + ข้อความเริ่มต้นที่แก้ได้ (ตัวแปร {ชื่อผู้แจ้ง} {เลข Ticket} {หัวข้อ}) */
  async notifyPreview(id: string) {
    const l = await this.findLink(id);
    const { reopenDays } = await this.support.config();
    return { link: { id: l.id, issueKey: l.issueKey, title: l.title, doneAt: l.doneAt, releasedAt: l.releasedAt, releaseVersion: l.releaseVersion }, tickets: await this.waiting(l.id), message: DEFAULT_MESSAGE, reopenDays };
  }

  private async replyAll(staff: Staff, l: Link, message: string, opts: { solve: boolean; csat: boolean; outcome: 'fixed' | 'workaround'; subjectPrefix: string }) {
    const list = await this.waiting(l.id);
    if (!list.length) throw new AppError(409, 'nothing_to_notify', 'แจ้งลูกค้าครบทุก Ticket แล้ว');
    const { reopenDays } = await this.support.config();
    const now = new Date();
    let sent = 0;
    for (const k of list) {
      const text = fill(message, { 'ชื่อผู้แจ้ง': k.requester ?? '', 'เลข Ticket': String(k.number), 'หัวข้อ': k.subject });
      await this.db.transaction(async (tx) => {
        await tx.insert(s.supportTicketMessages).values({ ticketId: k.id, authorKind: 'staff', authorStaffId: staff.id, body: text });
        await tx
          .update(s.supportTickets)
          .set(
            opts.solve
              ? { status: 'solved', solvedAt: now, cause: sql`coalesce(${s.supportTickets.cause}, ${`แก้โดยทีมพัฒนา (${l.issueKey})`})`, firstRespondedAt: sql`coalesce(${s.supportTickets.firstRespondedAt}, ${now})`, updatedAt: now }
              : { status: 'pending_customer', firstRespondedAt: sql`coalesce(${s.supportTickets.firstRespondedAt}, ${now})`, updatedAt: now },
          )
          .where(eq(s.supportTickets.id, k.id));
        await tx.update(T).set({ notifiedAt: now, notifiedBy: staff.id, outcome: opts.outcome }).where(eq(T.ticketId, k.id));
        await tx.insert(s.supportTicketMessages).values({ ticketId: k.id, authorKind: 'staff', authorStaffId: staff.id, internal: true, body: `แจ้งลูกค้าแล้ว (${opts.outcome === 'fixed' ? 'แก้แล้ว' : 'ยังไม่แก้ + ทางเลี่ยง'}) · ${l.issueKey}` });
      });
      if (k.workspaceId) await audit(this.db, staff, k.workspaceId, 'data', 'dev.customer_notified', `#${k.number} · แจ้งลูกค้า ${opts.outcome === 'fixed' ? 'แก้แล้ว' : 'ทางเลี่ยง'} (${l.issueKey})`, { type: 'support_ticket', id: k.id });
      // อีเมล T13 (กระดิ่งในแอปมาจาก support.replied ของ API ลูกค้าที่สแกนข้อความนี้)
      if (k.email) {
        const link = k.slug ? `${config.appUrl}/work/${k.slug}/help/tickets?ticket=${k.id}` : config.appUrl;
        try {
          await this.mail.send({
            to: k.email,
            subject: `[#${k.number}] ${opts.subjectPrefix}: ${k.subject}`,
            text: `${text}\n\nดู Ticket: ${link}\n${opts.solve ? `ตอบกลับอีเมลนี้เพื่อเปิดเรื่องต่อ · ปิดเองใน ${reopenDays} วันถ้าไม่มีการตอบกลับ${opts.csat ? '\nช่วยให้คะแนนความพึงพอใจ 1–5 โดยตอบกลับอีเมลนี้เป็นตัวเลข' : ''}` : 'ตอบกลับได้ในหน้า Ticket ของฉัน'}`,
          });
          sent++;
        } catch {
          // อีเมลล้มไม่ย้อนการแจ้งในแอป
        }
      }
    }
    return { notified: list.length, emailed: sent };
  }

  async notify(staff: Staff, id: string, input: z.infer<typeof NotifyBody>) {
    const l = await this.findLink(id);
    if (l.statusCategory !== 'done') throw new AppError(409, 'not_done', 'งานนี้ยังไม่เสร็จในฝั่งทีมพัฒนา');
    const r = await this.replyAll(staff, l, input.message, { solve: input.solve, csat: input.csat, outcome: 'fixed', subjectPrefix: 'แก้แล้ว' });
    let changelogId: string | null = null;
    if (input.changelog) {
      const [c] = await this.db.insert(s.changelogEntries).values({ kind: 'fixed', title: l.title, summary: l.title, status: 'draft', devIssueLinkId: l.id, createdBy: staff.id, updatedBy: staff.id }).returning({ id: s.changelogEntries.id });
      changelogId = c.id;
    }
    await staffAudit(this.db, staff, 'dev.customers_notified', `แจ้งลูกค้าว่า ${l.issueKey} แก้แล้ว ${r.notified} ราย${changelogId ? ' · ร่าง Changelog' : ''}`, { type: 'dev_issue_link', id: l.id });
    return { ...r, changelogId };
  }

  /** T10: งานถูกปิดแบบไม่แก้ / ซ้ำ · ผูกไปงานที่แก้แล้ว / แจ้งพร้อมทางเลี่ยง / คืนให้ Support */
  async resolve(staff: Staff, id: string, input: z.infer<typeof ResolveBody>) {
    const l = await this.findLink(id);
    if (input.action === 'workaround') {
      const r = await this.replyAll(staff, l, input.message, { solve: false, csat: false, outcome: 'workaround', subjectPrefix: 'ความคืบหน้า' });
      await staffAudit(this.db, staff, 'dev.workaround_sent', `${l.issueKey} ไม่แก้ · แจ้งทางเลี่ยง ${r.notified} ราย`, { type: 'dev_issue_link', id: l.id });
      return r;
    }
    const list = await this.waiting(l.id);
    if (!list.length) throw new AppError(409, 'nothing_to_notify', 'ไม่มี Ticket ที่รอดำเนินการ');
    if (input.action === 'return') {
      const now = new Date();
      for (const k of list) {
        await this.db.update(T).set({ outcome: 'returned' }).where(eq(T.ticketId, k.id));
        await this.db.update(s.supportTickets).set({ status: 'open', updatedAt: now }).where(and(eq(s.supportTickets.id, k.id), eq(s.supportTickets.status, 'pending_dev')));
        await this.db.insert(s.supportTicketMessages).values({ ticketId: k.id, authorKind: 'staff', authorStaffId: staff.id, internal: true, body: `ทีมพัฒนาปิด ${l.issueKey} (${l.statusName ?? 'ไม่แก้'}) · คืนให้ Support ตรวจต่อ${input.note ? ` · ${input.note}` : ''}` });
      }
      await staffAudit(this.db, staff, 'dev.tickets_returned', `${l.issueKey} คืน Ticket ให้ Support ${list.length} ราย`, { type: 'dev_issue_link', id: l.id });
      return { returned: list.length };
    }
    // ผูกไปงานที่แก้แล้ว: ย้าย Ticket ที่ยังรอไปงานใหม่ แล้วแจ้งลูกค้าตามงานนั้น (T9)
    const { fm, mapping } = await this.client();
    const issue = await fm.getIssue(input.targetKey);
    const target = await this.upsertLink(staff, issue, l.severity, mapping, fm);
    await this.db.update(T).set({ linkId: target.id, linkedBy: staff.id, linkedAt: new Date() }).where(and(eq(T.linkId, l.id), isNull(T.notifiedAt)));
    await this.internalNote(list.map((k) => k.id), `${l.issueKey} ซ้ำกับ ${target.issueKey} · ย้ายไปผูกกับ ${target.issueKey}`);
    await staffAudit(this.db, staff, 'dev.tickets_moved', `ย้าย ${list.length} Ticket จาก ${l.issueKey} ไป ${target.issueKey}`, { type: 'dev_issue_link', id: target.id });
    return { moved: list.length, linkId: target.id, issueKey: target.issueKey };
  }
}
