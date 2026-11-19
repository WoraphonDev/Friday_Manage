// N. หลังบ้าน Friday · ยกเว้น support_access_grants ที่ลูกค้าเปิด/ปิดสิทธิ์เองผ่าน A31
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, boolean, check, customType, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { users } from './identity.ts';
import { workspaceId } from './project.ts';
import { workspaces } from './workspace.ts';
import { announcementAudience, supportMode } from './saas-enums.ts';

/** ค่าที่อนุญาตของคอลัมน์ text · ใช้แทน enum ในตารางของทีม Friday เพื่อเพิ่มค่าได้ง่าย */
const oneOf = (col: AnyPgColumn, values: readonly string[]) => sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const STAFF_ROLES = ['owner', 'finance', 'support', 'engineer', 'auditor'] as const;
export const STAFF_STATUSES = ['invited', 'active', 'suspended', 'disabled'] as const;

/** พนักงานทีม Friday (06-ops-roles) · 1 คนมีได้หลายบทบาทใน `roles` · `role` เดิมลบใน migration 0019 (O01) */
export const staffUsers = pgTable('staff_users', {
  id: pk(), email: text().notNull(), name: text().notNull(),
  roles: text().array().notNull().default(sql`'{}'`),
  department: text(),
  /** วงเงินทำเองรายคน · null = ใช้ค่าเริ่มต้น (refund_satang, credit_satang, discount_pct, discount_cycles, trial_days, trial_times) */
  limits: jsonb(),
  status: text().notNull().default('active'),
  /** ผู้ตรวจภายนอก (เช่น สำนักงานบัญชี) หมดสิทธิ์อัตโนมัติ */
  expiresAt: tstz(),
  webauthnCredentials: jsonb().notNull().default(sql`'[]'::jsonb`),
  /**
   * ทางเลือกแทน Security key (ใช้ได้ทุกเครื่อง/โหมดไม่ระบุตัวตน): รหัสผ่าน (scrypt) + TOTP จากแอป Authenticator
   * ตั้งพร้อมกันเสมอ · totp_enabled_at ไม่ว่าง = ใช้วิธีนี้ได้ · totp_last_step กันใช้รหัสเดิมซ้ำ
   */
  passwordHash: text(), totpSecretEnc: text(), totpEnabledAt: tstz(), totpLastStep: bigint({ mode: 'number' }),
  /** ใส่รหัสผ่าน/รหัส 6 หลักผิดติดกัน · ครบ 5 ครั้งล็อก 15 นาที */
  failedLoginCount: integer().notNull().default(0), lockedUntil: tstz(),
  /**
   * อีเมลส่วนตัว (รอบ 4 · H1) · รับสรุปรายการที่อนุมัติตัวเองและแจ้งสิทธิ์ฉุกเฉิน (06-ops-roles ข้อ 4–5)
   * pending + code_hash = รอยืนยันด้วยรหัส 6 หลัก · ระหว่างรอยังส่งถึงอีเมลที่ยืนยันแล้ว
   */
  personalEmail: text(), personalEmailVerifiedAt: tstz(), personalEmailPending: text(),
  personalEmailCodeHash: text(), personalEmailCodeExpiresAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('staff_users_email_key').on(sql`lower(${t.email})`),
  check('staff_users_roles_valid', sql`cardinality(${t.roles}) >= 1 AND ${t.roles} <@ ARRAY[${sql.raw(STAFF_ROLES.map((r) => `'${r}'`).join(', '))}]::text[]`),
  check('staff_users_status_valid', oneOf(t.status, STAFF_STATUSES))]);

/**
 * สิทธิ์ชั่วคราว · break_glass = Owner เปิดบทบาทที่ไม่มีให้ตัวเอง (ไม่เกิน 1 ชม.) · approved = พนักงานขอแล้ว Owner อนุมัติ (O52 · ไม่เกิน 8 ชม. · ห้ามบทบาท Owner)
 * approval_request_id ผูกคำขอ · ticket_ref = Ticket ที่เกี่ยวข้อง (ไม่บังคับ)
 */
export const staffElevations = pgTable('staff_elevations', {
  id: pk(), staffId: uuid().notNull().references(() => staffUsers.id), role: text().notNull(), reason: text().notNull(),
  startedAt: tstz().notNull().defaultNow(), endsAt: tstz().notNull(), endedAt: tstz(), endedBy: uuid().references(() => staffUsers.id),
  kind: text().notNull().default('break_glass'), approvalRequestId: uuid().references((): AnyPgColumn => approvalRequests.id), ticketRef: text(),
  /** เตือนผู้ใช้สิทธิ์ว่าเหลือ 5 นาทีแล้ว */
  warnedAt: tstz(),
  createdAt: createdAt(),
}, (t) => [index('staff_elevations_staff_idx').on(t.staffId, t.endsAt),
  check('staff_elevations_role_valid', oneOf(t.role, STAFF_ROLES)),
  check('staff_elevations_kind_valid', oneOf(t.kind, ['break_glass', 'approved'])),
  check('staff_elevations_window', sql`${t.endsAt} > ${t.startedAt} AND ${t.endsAt} <= ${t.startedAt} + CASE WHEN ${t.kind} = 'approved' THEN interval '8 hours' ELSE interval '1 hour' END`),
  check('staff_elevations_approved', sql`${t.kind} <> 'approved' OR (${t.approvalRequestId} IS NOT NULL AND ${t.role} <> 'owner')`)]);

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;

/** คำขออนุมัติเมื่อทำเกินวงเงิน · ห้ามผู้ขออนุมัติเอง ยกเว้นช่วงมี Owner คนเดียว (self_approved) */
export const approvalRequests = pgTable('approval_requests', {
  id: pk(), kind: text().notNull(),
  /** null = ไม่ผูก Workspace เช่น เพิ่ม Owner หรือปิดปรับปรุงทั้งระบบ */
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'cascade' }),
  targetType: text(), targetId: uuid(), payload: jsonb().notNull().default(sql`'{}'::jsonb`),
  amountSatang: bigint({ mode: 'number' }),
  requestedBy: uuid().notNull().references(() => staffUsers.id), reason: text().notNull(),
  status: text().notNull().default('pending'), decidedBy: uuid().references(() => staffUsers.id), decidedAt: tstz(), decisionNote: text(),
  selfApproved: boolean().notNull().default(false), expiresAt: tstz().notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('approval_requests_status_idx').on(t.status, t.expiresAt), index('approval_requests_workspace_idx').on(t.workspaceId),
  check('approval_requests_status_valid', oneOf(t.status, APPROVAL_STATUSES)),
  check('approval_requests_decision', sql`(${t.status} IN ('pending', 'expired', 'cancelled')) = (${t.decidedBy} IS NULL)`),
  check('approval_requests_self', sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy} OR ${t.selfApproved}`)]);

/** การกระทำของทีม Friday ที่ไม่ผูก Workspace (พนักงาน บทบาท ตั้งค่า) · append-only · การกระทำกับลูกค้ายังเขียน audit_logs ของ Workspace */
export const staffAuditLogs = pgTable('staff_audit_logs', {
  id: pk(),
  /** ไม่ใส่ FK เพื่อให้ประวัติอยู่ครบแม้ปิดบัญชีพนักงาน */
  staffId: uuid(), roles: text().array().notNull().default(sql`'{}'`),
  action: text().notNull(), targetType: text(), targetId: uuid(), workspaceId: uuid(),
  reason: text(), approvedBy: uuid(), selfApproved: boolean().notNull().default(false),
  ip: text(), userAgent: text(),
  /** ทำระหว่างใช้สิทธิ์ชั่วคราว (O52) · หน้า Audit log ติดป้ายและลิงก์กลับคำขอ */
  elevationId: uuid(),
  createdAt: createdAt(),
}, (t) => [index('staff_audit_logs_created_idx').on(t.createdAt), index('staff_audit_logs_staff_idx').on(t.staffId, t.createdAt),
  index('staff_audit_logs_elevation_idx').on(t.elevationId).where(sql`${t.elevationId} IS NOT NULL`)]);

/** แยก Workspace ด้วย RLS · สมาชิกอ่านได้ แต่เขียนได้เฉพาะ Owner (RLS 0009 + API ของ A31) */
export const supportAccessGrants = pgTable('support_access_grants', {
  id: pk(), workspaceId: workspaceId().unique(), grantedBy: uuid().notNull().references(() => users.id),
  until: tstz(), maxMode: supportMode().notNull().default('read'), notifyAdmins: boolean().notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const TICKET_STATUSES = ['open', 'pending_customer', 'pending_dev', 'solved', 'closed'] as const;

/** Ticket ของ Support · เฟส 1 ใช้คิวกลาง (assignee ว่าง = อยู่ในคิว) */
export const supportTickets = pgTable('support_tickets', {
  id: pk(), number: integer().generatedAlwaysAsIdentity().notNull().unique(),
  /** null = ยังไม่รู้ว่าเป็นลูกค้า Workspace ไหน (เช่น อีเมลจากคนที่ล็อกอินไม่ได้) */
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'set null' }),
  requesterUserId: uuid().references(() => users.id, { onDelete: 'set null' }), requesterEmail: text(),
  channel: text().notNull().default('in_app'), category: text(), priority: text().notNull().default('normal'),
  subject: text().notNull(), status: text().notNull().default('open'),
  assigneeId: uuid().references(() => staffUsers.id),
  firstResponseDueAt: tstz(), resolutionDueAt: tstz(), firstRespondedAt: tstz(), solvedAt: tstz(), closedAt: tstz(),
  /** สาเหตุจริงตอนปิด · ใช้ทำรายงานเรื่องที่ถูกถามบ่อย */
  cause: text(), csat: smallint(),
  /** กฎการแจกงานที่ตรง (O22) · null = ไม่มีกฎตรงหรือสร้างก่อนมีกฎ */
  ruleId: uuid().references((): AnyPgColumn => supportRules.id, { onDelete: 'set null' }),
  /** แจ้งเตือน SLA ที่ส่งแล้ว { firstWarn, firstBreach, resolveWarn, resolveBreach }: ISO time · กันส่งซ้ำ */
  slaAlerts: jsonb().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('support_tickets_queue_idx').on(t.status, t.assigneeId, t.createdAt), index('support_tickets_workspace_idx').on(t.workspaceId),
  unique('support_tickets_workspace_id_key').on(t.workspaceId, t.id),
  check('support_tickets_status_valid', oneOf(t.status, TICKET_STATUSES)),
  check('support_tickets_channel_valid', oneOf(t.channel, ['in_app', 'email', 'phone', 'line'])),
  check('support_tickets_priority_valid', oneOf(t.priority, ['low', 'normal', 'high', 'urgent'])),
  check('support_tickets_requester', sql`${t.requesterUserId} IS NOT NULL OR ${t.requesterEmail} IS NOT NULL`),
  check('support_tickets_csat', sql`${t.csat} IS NULL OR ${t.csat} BETWEEN 1 AND 5`)]);

/** หมวด Ticket (O22) · ใช้ในกฎแยกตามประเภท · Ticket เก่าที่พิมพ์หมวดเองยังเก็บเป็นข้อความเดิม */
export const TICKET_CATEGORIES = ['how_to', 'feature_request', 'bug', 'import', 'notification', 'api', 'billing', 'tax_invoice', 'payment', 'outage', 'account', 'other'] as const;
/** กลุ่มงาน Support · lead = หัวหน้าทีม (ได้แจ้งเตือนเมื่อเกิน SLA) · acct/all เป็นปลายทางของกฎ ไม่ใช่กลุ่มที่สมาชิกอยู่ */
export const SUPPORT_GROUPS = ['l1', 'l2', 'fin', 'lead'] as const;
export const SUPPORT_RULE_TARGETS = ['l1', 'l2', 'fin', 'acct', 'all'] as const;
export const SUPPORT_PRESENCE = ['online', 'busy', 'offline', 'leave'] as const;

/**
 * ตั้งค่าการแจกงาน Support (O22) · มีแถวเดียว (id = 1) · `config` ตรวจรูปด้วย zod ใน ops-api (support/settings.service.ts)
 * round_robin_last = คนล่าสุดที่ได้งานแบบวนตามลำดับ
 */
export const supportSettings = pgTable('support_settings', {
  id: smallint().primaryKey().default(1), config: jsonb().notNull().default(sql`'{}'::jsonb`),
  roundRobinLast: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  updatedBy: uuid().references(() => staffUsers.id), updatedAt: updatedAt(),
}, (t) => [check('support_settings_singleton', sql`${t.id} = 1`)]);

/** กฎแยกตามประเภท (T6) · ตรวจตาม position จากน้อยไปมาก ตรงข้อแรกแล้วหยุด · เงื่อนไขว่าง = ทุกค่า */
export const supportRules = pgTable('support_rules', {
  id: pk(), position: integer().notNull(), name: text(),
  plans: text().array().notNull().default(sql`'{}'`), categories: text().array().notNull().default(sql`'{}'`),
  target: text().notNull(), priority: text().notNull().default('normal'), enabled: boolean().notNull().default(true),
  createdBy: uuid().references(() => staffUsers.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('support_rules_position_idx').on(t.position),
  check('support_rules_target_valid', oneOf(t.target, SUPPORT_RULE_TARGETS)),
  check('support_rules_priority_valid', oneOf(t.priority, ['low', 'normal', 'high', 'urgent']))]);

/** ข้อมูลการรับงานของพนักงาน Support · ไม่มีแถว = ออนไลน์ ไม่อยู่กลุ่มใด เพดานตามค่าเริ่มต้น */
export const supportAgents = pgTable('support_agents', {
  staffId: uuid().primaryKey().references(() => staffUsers.id, { onDelete: 'cascade' }),
  groups: text().array().notNull().default(sql`'{}'`),
  /** null = ใช้เพดานค่าเริ่มต้นใน support_settings */
  cap: smallint(),
  presence: text().notNull().default('online'), presenceNote: text(), presenceAt: tstz(),
  /** ทำไมเปลี่ยนสถานะล่าสุด (รอบ 4 · S3): manual = ตั้งเอง · logout / idle / session = ระบบเปลี่ยนเป็นออฟไลน์ */
  presenceReason: text(),
  /** เปิดหน้า Ops ครั้งล่าสุด · ใช้ตัดสิน "ไม่มีการใช้งาน" */
  lastSeenAt: tstz(),
  updatedAt: updatedAt(),
}, (t) => [check('support_agents_groups_valid', sql`${t.groups} <@ ARRAY[${sql.raw(SUPPORT_GROUPS.map((g) => `'${g}'`).join(', '))}]::text[]`),
  check('support_agents_presence_valid', oneOf(t.presence, SUPPORT_PRESENCE)),
  check('support_agents_cap', sql`${t.cap} IS NULL OR ${t.cap} BETWEEN 1 AND 99`),
  check('support_agents_presence_reason_valid', sql`${t.presenceReason} IS NULL OR ${t.presenceReason} IN ('manual', 'logout', 'idle', 'session')`)]);

/** ผู้ดูแลประจำบัญชี (Enterprise) · 1 Workspace มีผู้ดูแล 1 คน · กฎที่ส่งไป "acct" แจกให้คนนี้ */
export const supportAccountManagers = pgTable('support_account_managers', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  staffId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [index('support_account_managers_staff_idx').on(t.staffId)]);

/**
 * ป้าย "ทดสอบ" ของ Workspace (ช่วง 1 · ข้อมูลเยอะ) · ไม่มีแถว = ตามกฎอัตโนมัติ (เจ้าของใช้โดเมนสงวนไว้ทดสอบ เช่น example.com, .test)
 * test = ทีมยืนยันว่าเป็นทดสอบ · not_test = ทีมยืนยันว่าเป็นลูกค้าจริงแม้เข้ากฎอัตโนมัติ · ลูกค้าไม่เห็นป้ายนี้
 */
export const opsWorkspaceFlags = pgTable('ops_workspace_flags', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  testFlag: text().notNull(), reason: text().notNull(),
  flaggedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('ops_workspace_flags_flag_idx').on(t.testFlag),
  check('ops_workspace_flags_valid', oneOf(t.testFlag, ['test', 'not_test']))]);

/**
 * ใครกำลังเปิด / พิมพ์อยู่ที่รายการไหน (ช่วง 2 · กันตอบซ้ำ) · หน้าเว็บส่งสัญญาณทุก 15 วินาที · เกิน 30 วินาที = ไม่อยู่แล้ว
 * ข้อมูลชั่วคราว ลบแถวเก่าเองตอนรับสัญญาณใหม่
 */
export const opsPresence = pgTable('ops_presence', {
  staffId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  targetType: text().notNull(), targetId: uuid().notNull(), mode: text().notNull(),
  seenAt: tstz().notNull().default(sql`now()`),
}, (t) => [primaryKey({ columns: [t.staffId, t.targetType, t.targetId] }), index('ops_presence_target_idx').on(t.targetType, t.targetId),
  check('ops_presence_type_valid', oneOf(t.targetType, ['ticket', 'payment', 'approval', 'privacy'])),
  check('ops_presence_mode_valid', oneOf(t.mode, ['viewing', 'typing']))]);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * บัญชีลูกค้าระดับบริษัท (ช่วง 3) · รวม Workspace ของผู้ซื้อเดียวกันและบริษัทในเครือ (เลขภาษีหลายเลข)
 * ระบบเสนอจากผู้ซื้อที่มีตั้งแต่ 2 Workspace คนยืนยัน (ไม่สร้างเอง) · enterprise มีสัญญา: SLA ตามสัญญาใช้แทนของแพ็กเกจ
 * contacts = [{ name, email, phone, role: signer | billing | it }] · contract_value เป็นสตางค์ต่อปี
 * contract_sla = { first, resolve } รูปแบบเดียวกับ SLA ของแพ็กเกจ · renewal_reminded = เตือนต่อสัญญาไปแล้วที่กี่วัน (90 / 60 / 30) ของวันหมดปัจจุบัน
 */
export const customerAccounts = pgTable('customer_accounts', {
  id: pk(), name: text().notNull(), taxIds: text().array().notNull().default(sql`'{}'`),
  managerId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  kind: text().notNull().default('standard'), contacts: jsonb().notNull().default(sql`'[]'::jsonb`), notes: text(),
  contractStart: date(), contractEnd: date(), contractValue: bigint({ mode: 'number' }), contractSeats: integer(), contractSla: jsonb(),
  renewalReminded: smallint(),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('customer_accounts_contract_end_idx').on(t.contractEnd),
  check('customer_accounts_kind_valid', oneOf(t.kind, ['standard', 'enterprise'])),
  check('customer_accounts_contract_range', sql`${t.contractEnd} IS NULL OR ${t.contractStart} IS NULL OR ${t.contractEnd} >= ${t.contractStart}`)]);

/** Workspace ในบัญชีลูกค้า · หนึ่ง Workspace อยู่ได้บัญชีเดียว */
export const customerAccountWorkspaces = pgTable('customer_account_workspaces', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  accountId: uuid().notNull().references(() => customerAccounts.id, { onDelete: 'cascade' }),
  addedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
}, (t) => [index('customer_account_workspaces_account_idx').on(t.accountId)]);

/** ไฟล์สัญญา (PDF ไม่เกิน 10 MB) · เก็บในฐานข้อมูลเพราะ ops-api ไม่มีที่เก็บไฟล์ของตัวเอง · บัญชีละหนึ่งไฟล์ (อัปโหลดใหม่ = แทนที่) */
export const customerAccountFiles = pgTable('customer_account_files', {
  accountId: uuid().primaryKey().references(() => customerAccounts.id, { onDelete: 'cascade' }),
  name: text().notNull(), mime: text().notNull(), size: integer().notNull(), data: bytea().notNull(),
  uploadedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
});

/**
 * มุมมองที่บันทึกไว้ (ช่วง 3) · roles ว่าง = ส่วนตัว · มีค่า = มุมมองของทีม (เห็นเฉพาะบทบาทที่เลือก · สร้างได้เฉพาะ Owner และหัวหน้าทีม Support)
 * filters = ตัวกรองของหน้านั้น (คีย์เดียวกับ query ของรายการ) · sort / tab เก็บใน filters ด้วย
 */
export const opsSavedViews = pgTable('ops_saved_views', {
  id: pk(), ownerId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  page: text().notNull(), name: text().notNull(), filters: jsonb().notNull().default({}),
  roles: text().array().notNull().default(sql`'{}'`),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('ops_saved_views_page_idx').on(t.page),
  check('ops_saved_views_page_valid', oneOf(t.page, ['workspaces', 'tickets', 'overdue', 'users', 'privacy', 'deliveries', 'invoices']))]);

/** การตั้งค่ามุมมองของแต่ละคน: ปักที่เมนูซ้าย · ซ่อนมุมมองของทีม · ลำดับ · มุมมองเริ่มต้นของหน้า */
export const opsViewPrefs = pgTable('ops_view_prefs', {
  staffId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  viewId: uuid().notNull().references(() => opsSavedViews.id, { onDelete: 'cascade' }),
  pinned: boolean().notNull().default(false), hidden: boolean().notNull().default(false),
  position: integer().notNull().default(0), isDefault: boolean().notNull().default(false),
}, (t) => [primaryKey({ columns: [t.staffId, t.viewId] })]);

/** ข้อความสำเร็จรูป (T4) · ตัวแปร {ชื่อผู้แจ้ง} {ชื่อ Workspace} {เลข Ticket} แทนค่าตอนใส่ในช่องตอบ · เลิกใช้แล้วเก็บไว้ (archived_at) */
export const supportCannedReplies = pgTable('support_canned_replies', {
  id: pk(), title: text().notNull(), body: text().notNull(), tag: text(), uses: integer().notNull().default(0),
  createdBy: uuid().references(() => staffUsers.id), updatedBy: uuid().references(() => staffUsers.id),
  archivedAt: tstz(), createdAt: createdAt(), updatedAt: updatedAt(),
});

export const supportTicketMessages = pgTable('support_ticket_messages', {
  id: pk(), ticketId: uuid().notNull().references(() => supportTickets.id, { onDelete: 'cascade' }),
  authorKind: text().notNull(), authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
  authorStaffId: uuid().references(() => staffUsers.id), body: text().notNull(),
  /** บันทึกภายใน ลูกค้าไม่เห็น */
  internal: boolean().notNull().default(false), attachments: jsonb().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
}, (t) => [index('support_ticket_messages_ticket_idx').on(t.ticketId, t.createdAt),
  check('support_ticket_messages_author_valid', oneOf(t.authorKind, ['customer', 'staff', 'system'])),
  check('support_ticket_messages_internal', sql`NOT ${t.internal} OR ${t.authorKind} = 'staff'`)]);

export const supportSessions = pgTable('support_sessions', {
  id: pk(), workspaceId: workspaceId(), staffId: uuid().notNull().references(() => staffUsers.id),
  /** เลข Ticket แบบข้อความเดิม · Ticket ในระบบใหม่ผูกผ่าน ticket_id */
  ticketNo: text().notNull(), ticketId: uuid(), reason: text().notNull(), mode: supportMode().notNull().default('read'),
  secondApproverId: uuid().references(() => staffUsers.id), startedAt: tstz().notNull().defaultNow(), endedAt: tstz(),
  /** เวลาหมด (30 นาที – 2 ชม. ตาม C1) · null = ข้อมูลก่อนมีเวลาหมด */
  expiresAt: tstz(),
  createdAt: createdAt(),
}, (t) => [index('support_sessions_workspace_idx').on(t.workspaceId, t.startedAt),
  foreignKey({ name: 'support_sessions_ticket_fk', columns: [t.workspaceId, t.ticketId], foreignColumns: [supportTickets.workspaceId, supportTickets.id] }),
  check('support_sessions_write_approval', sql`${t.mode} <> 'write' OR (${t.secondApproverId} IS NOT NULL AND ${t.secondApproverId} <> ${t.staffId})`),
  check('support_sessions_dates', sql`${t.endedAt} >= ${t.startedAt}`),
  check('support_sessions_expiry', sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.startedAt}`)]);

export const featureFlags = pgTable('feature_flags', {
  id: pk(), key: text().notNull().unique(), description: text(), defaultOn: boolean().notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  id: pk(), flagId: uuid().notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(), enabled: boolean().notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('feature_flag_overrides_key').on(t.flagId, t.workspaceId)]);

/**
 * ประกาศถึงลูกค้า (O24 · C8) · ส่งถึง Owner / Admin ของ Workspace ที่เลือกใน announcement_targets
 * sent_at = เวลาที่ส่งจริง (ตอนนี้ หรือถึง scheduled_at) · cancelled_at = ยกเลิกก่อนส่ง หรือหยุดแสดงแบนเนอร์หลังส่ง
 */
export const announcements = pgTable('announcements', {
  id: pk(), message: text().notNull(), audience: announcementAudience().notNull().default('all'),
  channels: text().array().notNull().default(sql`'{banner}'`), scheduledAt: tstz(), sentAt: tstz(),
  /** หัวข้อ (หัวเรื่องอีเมล / หัวแบนเนอร์) · ประกาศเดิมก่อน O24 ไม่มี */
  title: text(),
  /** ผู้รับ (รอบ 4 · S8): selected = Workspace ที่เลือก (announcement_targets) · filter = ตามตัวกรอง หาตอนส่ง · all = ลูกค้าที่ใช้งานอยู่ทุกราย */
  targetMode: text().notNull().default('selected'), targetFilter: jsonb(),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  cancelledAt: tstz(), cancelledBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('announcements_due_idx').on(t.scheduledAt).where(sql`${t.sentAt} IS NULL AND ${t.cancelledAt} IS NULL`),
  check('announcements_target_mode_valid', oneOf(t.targetMode, ['selected', 'filter', 'all']))]);

/**
 * Workspace ที่ได้รับประกาศ · ตอนส่ง ops-api ใส่ข้อความที่แทนตัวแปรของ Workspace นั้นแล้ว (banner_*) ให้ API ลูกค้าอ่านผ่าน RLS
 * จึงไม่ต้องเปิดตาราง announcements (ของทีม Friday) ให้ลูกค้า · banner_from ว่าง = ยังไม่ส่ง หรือไม่มีช่องทางแบนเนอร์
 */
export const announcementTargets = pgTable('announcement_targets', {
  announcementId: uuid().notNull().references(() => announcements.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  /** จำนวน Owner / Admin ตอนส่ง */
  recipients: integer(),
  bannerTitle: text(), bannerMessage: text(), bannerFrom: tstz(), bannerUntil: tstz(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.announcementId, t.workspaceId] }),
  index('announcement_targets_workspace_idx').on(t.workspaceId, t.bannerFrom)]);

/** ผู้ใช้ปิดแบนเนอร์ประกาศแล้ว (ต่อคน ต่อ Workspace) */
export const announcementDismissals = pgTable('announcement_dismissals', {
  announcementId: uuid().notNull(), workspaceId: workspaceId(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  dismissedAt: tstz().notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.announcementId, t.workspaceId, t.userId] }),
  foreignKey({ name: 'announcement_dismissals_target_fk', columns: [t.announcementId, t.workspaceId], foreignColumns: [announcementTargets.announcementId, announcementTargets.workspaceId] }).onDelete('cascade')]);

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

/** เหตุขัดข้องที่แสดงในหน้าสถานะสาธารณะ · internal = บันทึกภายใน ยังไม่เผยแพร่ */
export const incidents = pgTable('incidents', {
  id: pk(), title: text().notNull(), impact: text().notNull().default('minor'), status: text().notNull().default('investigating'),
  services: text().array().notNull().default(sql`'{}'`), ownerId: uuid().references(() => staffUsers.id),
  internal: boolean().notNull().default(false), startedAt: tstz().notNull().defaultNow(), resolvedAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('incidents_status_idx').on(t.status, t.startedAt),
  check('incidents_impact_valid', oneOf(t.impact, ['minor', 'partial', 'major'])),
  check('incidents_status_valid', oneOf(t.status, INCIDENT_STATUSES)),
  check('incidents_resolved', sql`(${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL)`)]);

/** Ticket ที่ผูกกับเหตุขัดข้อง (ช่วง 3) · หนึ่ง Ticket ผูกได้เหตุเดียว · ปิดเหตุแล้วส่งข้อความปิดเรื่องให้ทุก Ticket ที่ผูกได้ */
export const supportTicketIncidents = pgTable('support_ticket_incidents', {
  ticketId: uuid().primaryKey().references(() => supportTickets.id, { onDelete: 'cascade' }),
  incidentId: uuid().notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  linkedBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('support_ticket_incidents_incident_idx').on(t.incidentId)]);

export const incidentUpdates = pgTable('incident_updates', {
  id: pk(), incidentId: uuid().notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  status: text().notNull(), message: text().notNull(),
  notifySubscribers: boolean().notNull().default(false), showBanner: boolean().notNull().default(false),
  createdBy: uuid().references(() => staffUsers.id), createdAt: createdAt(),
}, (t) => [index('incident_updates_incident_idx').on(t.incidentId, t.createdAt), check('incident_updates_status_valid', oneOf(t.status, INCIDENT_STATUSES))]);

/** ปิดปรับปรุง · API ฝั่งลูกค้าอ่านแถวที่ active เพื่อเปลี่ยนเป็นอ่านอย่างเดียว */
export const maintenanceWindows = pgTable('maintenance_windows', {
  id: pk(), scope: text().notNull().default('read_only'), message: text().notNull(),
  startsAt: tstz().notNull(), endsAt: tstz().notNull(), notifyPlan: text().notNull().default('3d_and_1h'),
  status: text().notNull().default('scheduled'), createdBy: uuid().references(() => staffUsers.id),
  approvalRequestId: uuid().references(() => approvalRequests.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('maintenance_windows_time_idx').on(t.status, t.startsAt),
  check('maintenance_windows_scope_valid', oneOf(t.scope, ['read_only', 'full', 'import_export'])),
  check('maintenance_windows_status_valid', oneOf(t.status, ['scheduled', 'active', 'done', 'cancelled'])),
  check('maintenance_windows_dates', sql`${t.endsAt} > ${t.startsAt}`)]);

/** ผู้ติดตามหน้าสถานะ (ไม่ต้องมีบัญชี) */
export const statusSubscribers = pgTable('status_subscribers', {
  id: pk(), email: text().notNull(), confirmTokenHash: text(), confirmedAt: tstz(), unsubscribedAt: tstz(), createdAt: createdAt(),
}, (t) => [uniqueIndex('status_subscribers_email_key').on(sql`lower(${t.email})`)]);

export const PRIVACY_REQUEST_TYPES = ['access', 'export', 'rectify', 'erase', 'object', 'restrict'] as const;

/**
 * คำขอ PDPA ที่ส่งถึงทีม Friday ในฐานะผู้ควบคุมข้อมูลบัญชี (O05 · A3) · ต่างจาก data_subject_requests ที่ลูกค้าแต่ละ Workspace รับเอง
 * ขั้นตอน 1 รับ · 2 ยืนยันตัวตน · 3 ตรวจขอบเขต · 4 ดำเนินการ · 5 แจ้งผล · ประวัติทุกขั้นอยู่ใน staff_audit_logs
 */
export const privacyRequests = pgTable('privacy_requests', {
  id: pk(), number: integer().generatedAlwaysAsIdentity().notNull().unique(),
  requestType: text().notNull(), requesterEmail: text().notNull(),
  /** บัญชีที่ตรงกับอีเมล · null = ไม่พบหรือถูกลบแล้ว */
  userId: uuid().references(() => users.id, { onDelete: 'set null' }),
  /** ขอบเขต · ว่าง = ทุก Workspace ที่เป็นสมาชิก */
  workspaceIds: uuid().array().notNull().default(sql`'{}'`),
  details: text(), receivedAt: tstz().notNull(), dueDate: date().notNull(),
  identity: text().notNull().default('unverified'), step: smallint().notNull().default(1), status: text().notNull().default('open'),
  rejectionReason: text(), handledBy: uuid().references(() => staffUsers.id), approvalRequestId: uuid().references(() => approvalRequests.id),
  completedAt: tstz(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('privacy_requests_status_idx').on(t.status, t.dueDate),
  check('privacy_requests_type_valid', oneOf(t.requestType, PRIVACY_REQUEST_TYPES)),
  check('privacy_requests_identity_valid', oneOf(t.identity, ['unverified', 'email_match', 'link_confirmed'])),
  check('privacy_requests_status_valid', oneOf(t.status, ['open', 'completed', 'rejected'])),
  check('privacy_requests_step', sql`${t.step} BETWEEN 1 AND 5`),
  check('privacy_requests_rejected', sql`(${t.status} = 'rejected') = (${t.rejectionReason} IS NOT NULL)`)]);

/** เหตุละเมิดข้อมูลส่วนบุคคล (O05 · A4) · ต้องแจ้ง สคส. ภายใน 72 ชม. นับจาก discovered_at ถ้าความเสี่ยงไม่ต่ำ */
export const dataBreaches = pgTable('data_breaches', {
  id: pk(), number: integer().generatedAlwaysAsIdentity().notNull().unique(),
  discoveredAt: tstz().notNull(), ownerId: uuid().notNull().references(() => staffUsers.id),
  description: text().notNull(), dataTypes: text().array().notNull().default(sql`'{}'`), affectedCount: integer(),
  workspaceIds: uuid().array().notNull().default(sql`'{}'`), risk: text().notNull().default('medium'),
  containment: text(), containedAt: tstz(), assessment: text(),
  pdpcNotifiedAt: tstz(), subjectsNotifiedAt: tstz(), closedAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('data_breaches_open_idx').on(t.closedAt, t.discoveredAt),
  check('data_breaches_risk_valid', oneOf(t.risk, ['low', 'medium', 'high'])),
  check('data_breaches_affected', sql`${t.affectedCount} IS NULL OR ${t.affectedCount} >= 0`)]);


/**
 * สิทธิ์และขีดจำกัดตามแพ็กเกจแบบมีเวอร์ชัน (Friday Ops เฟส 2 · O21) · แก้แล้วบันทึกเป็นเวอร์ชันใหม่เสมอ ไม่แก้แถวเดิม
 * `matrix` = { [plan code]: { [key]: number | boolean | null } } · null = ไม่จำกัด · คีย์อยู่ใน plan-entitlements.ts
 * เวอร์ชันที่ใช้ = เลขสูงสุดที่ effective_at ผ่านแล้ว · ลูกค้าที่ถูกลดสิทธิ์ใช้ค่าเดิมจนจบรอบบิล (P2)
 */
export const entitlementVersions = pgTable('entitlement_versions', {
  id: pk(), version: integer().notNull().unique(), matrix: jsonb().notNull(),
  effectiveAt: tstz().notNull(), reason: text().notNull(),
  /** เวอร์ชันเดิมที่กู้กลับมา (P3) */
  restoredFrom: integer(),
  createdBy: uuid().references(() => staffUsers.id), approvedBy: uuid().references(() => staffUsers.id),
  approvalRequestId: uuid().references(() => approvalRequests.id),
  createdAt: createdAt(),
}, (t) => [check('entitlement_versions_version_positive', sql`${t.version} > 0`)]);

/**
 * ปรับเฉพาะราย (override) ใช้แทนค่าของแพ็กเกจ · ต้องมีเหตุผล และวันหมดอายุ ยกเว้นตามสัญญา Enterprise (contract_ref)
 * `value` = number | boolean | null (ไม่จำกัด) · ยกเลิกแล้วเก็บไว้ดูย้อนหลัง (revoked_at)
 */
export const entitlementOverrides = pgTable('entitlement_overrides', {
  id: pk(), workspaceId: workspaceId(), key: text().notNull(), value: jsonb(),
  expiresAt: tstz(), contractRef: text(), reason: text().notNull(),
  createdBy: uuid().notNull().references(() => staffUsers.id), approvedBy: uuid().references(() => staffUsers.id),
  /** แจ้งเจ้าของรายการล่วงหน้า 7 วันแล้ว */
  warnedAt: tstz(),
  revokedAt: tstz(), revokedBy: uuid().references(() => staffUsers.id), revokeReason: text(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('entitlement_overrides_workspace_idx').on(t.workspaceId, t.key),
  uniqueIndex('entitlement_overrides_active_key').on(t.workspaceId, t.key).where(sql`${t.revokedAt} IS NULL`),
  check('entitlement_overrides_expiry', sql`${t.expiresAt} IS NOT NULL OR ${t.contractRef} IS NOT NULL`)]);

/**
 * Web Push ของพนักงาน (O25 · Friday Ops บนมือถือ) · 1 เครื่อง/เบราว์เซอร์ = 1 แถว · ปลายทางตอบ 404/410 = ลบแถวทิ้ง
 * `p256dh` / `auth` เป็นกุญแจสาธารณะของเบราว์เซอร์ ใช้เข้ารหัสข้อความ (ไม่ใช่ความลับฝั่งเรา)
 */
export const staffPushSubscriptions = pgTable('staff_push_subscriptions', {
  id: pk(), staffId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  endpoint: text().notNull(), p256dh: text().notNull(), auth: text().notNull(), userAgent: text(),
  lastSentAt: tstz(),
  /** ผลการส่งครั้งล่าสุด (รอบ 4 · S12) · เดิม log อย่างเดียว */
  lastOkAt: tstz(), lastError: text(), lastErrorAt: tstz(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('staff_push_subscriptions_endpoint_key').on(t.endpoint), index('staff_push_subscriptions_staff_idx').on(t.staffId)]);

/** กันส่งแจ้งเตือนเรื่องเดิมซ้ำ (เช่น คิวชำระใกล้ครบ SLA) · key = ประเภท:รหัสรายการ */
export const staffPushNotices = pgTable('staff_push_notices', {
  key: text().primaryKey(), sentAt: createdAt(),
});

/**
 * ค่าตั้งของ Friday Ops แบบ key → JSON (รอบ 4) · ค่าว่าง = ใช้ค่าเริ่มต้นในโค้ด
 * accounting = ส่งรายงานสำนักงานบัญชี (E6) · retention = ระยะเก็บข้อมูล (H12) · alerts = เกณฑ์ Error rate (S11)
 */
export const opsSettings = pgTable('ops_settings', {
  key: text().primaryKey(), value: jsonb().notNull().default(sql`'{}'::jsonb`),
  updatedBy: uuid().references(() => staffUsers.id), updatedAt: updatedAt(),
});

/** Legal hold (รอบ 4 · H11) · ระหว่างนี้งานลบถาวรทุกชนิดข้ามข้อมูลในขอบเขต · ยกเลิก = ใส่ released_* (ต้องมีคนที่สองอนุมัติ) */
export const legalHolds = pgTable('legal_holds', {
  id: pk(), workspaceId: uuid().notNull().references(() => workspaces.id),
  scope: text().notNull().default('workspace'), userIds: uuid().array().notNull().default(sql`'{}'`),
  reason: text().notNull(), reference: text().notNull(), reviewOn: date(), notifyCustomer: boolean().notNull().default(false),
  createdBy: uuid().notNull().references(() => staffUsers.id), createdAt: createdAt(),
  releasedAt: tstz(), releasedBy: uuid().references(() => staffUsers.id), releaseReason: text(),
}, (t) => [index('legal_holds_active_idx').on(t.workspaceId).where(sql`${t.releasedAt} IS NULL`),
  check('legal_holds_scope_valid', oneOf(t.scope, ['workspace', 'users'])),
  check('legal_holds_users_when_scoped', sql`${t.scope} = 'workspace' OR cardinality(${t.userIds}) > 0`)]);

/** การแจ้งเตือนของระบบที่เปิดอยู่ / เคยเกิด (รอบ 4 · S10) · kind = error_rate · 1 แถวต่อช่วงที่เกินเกณฑ์ */
export const systemAlerts = pgTable('system_alerts', {
  id: pk(), kind: text().notNull(), startedAt: tstz().notNull().defaultNow(), resolvedAt: tstz(),
  details: jsonb().notNull().default(sql`'{}'::jsonb`), lastNotifiedAt: tstz(),
  acknowledgedBy: uuid().references(() => staffUsers.id), acknowledgedAt: tstz(),
  incidentId: uuid().references((): AnyPgColumn => incidents.id), createdAt: createdAt(),
}, (t) => [index('system_alerts_open_idx').on(t.kind).where(sql`${t.resolvedAt} IS NULL`),
  check('system_alerts_kind_valid', oneOf(t.kind, ['error_rate']))]);

export const ABUSE_KINDS = ['fake_signup', 'invite_spam', 'api_abuse', 'payment'] as const;
export const ABUSE_OUTCOMES = ['dismissed', 'verify_identity', 'suspended', 'blocked'] as const;

/**
 * เคสตรวจจับการใช้ผิด (O50 · เฟส 3) · subject = เรื่องที่ถูกให้คะแนน (`ws:<uuid>` หรือ `ip:<address>`) เปิดได้ครั้งละหนึ่งเคส
 * signals = [{ rule, points, detail }] ที่มาของคะแนน · status: open = รอตรวจ · auto_suspended = ระบบระงับไปก่อน รอคนยืนยัน · closed = ตัดสินแล้ว
 * suspended_ids = Workspace ที่ระบบ / การตัดสินนี้ระงับ ใช้ปลดคืนเมื่อตัดสินว่าไม่ใช่การใช้ผิด (ไม่ปลด Workspace ที่ถูกระงับด้วยเหตุอื่น)
 */
export const abuseCases = pgTable('abuse_cases', {
  id: pk(), number: integer().generatedAlwaysAsIdentity().notNull().unique(),
  kind: text().notNull(), subject: text().notNull(), label: text().notNull(),
  workspaceIds: uuid().array().notNull().default(sql`'{}'`), userIds: uuid().array().notNull().default(sql`'{}'`), ip: text(),
  score: smallint().notNull(), signals: jsonb().notNull().default(sql`'[]'::jsonb`),
  status: text().notNull().default('open'),
  autoSuspendedAt: tstz(), suspendedIds: uuid().array().notNull().default(sql`'{}'`),
  /** แจ้ง Owner ครั้งล่าสุดว่าระงับอัตโนมัติแล้วยังไม่มีคนยืนยันเกิน 24 ชม. */
  remindedAt: tstz(),
  outcome: text(), reason: text(), decidedBy: uuid().references(() => staffUsers.id), decidedAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('abuse_cases_open_subject_key').on(t.subject).where(sql`${t.status} <> 'closed'`),
  index('abuse_cases_status_idx').on(t.status, t.score), index('abuse_cases_decided_idx').on(t.decidedAt),
  check('abuse_cases_kind_valid', oneOf(t.kind, ABUSE_KINDS)),
  check('abuse_cases_status_valid', oneOf(t.status, ['open', 'auto_suspended', 'closed'])),
  check('abuse_cases_outcome_valid', sql`${t.outcome} IS NULL OR ${t.outcome} IN (${sql.raw(ABUSE_OUTCOMES.map((o) => `'${o}'`).join(', '))})`),
  check('abuse_cases_closed', sql`(${t.status} = 'closed') = (${t.outcome} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`),
  check('abuse_cases_score', sql`${t.score} BETWEEN 0 AND 999`)]);

export const ABUSE_BLOCK_KINDS = ['email_domain', 'ip', 'workspace_slug', 'api_token'] as const;

/**
 * รายชื่อที่ถูกบล็อก (O50) · API ลูกค้าอ่านผ่าน SYSTEM_DB ตอนสมัคร / สร้าง Workspace · ip เก็บเป็น IP เดี่ยวหรือ CIDR
 * api_token: value = id ของ token (ops-api ยกเลิก token ทันทีตอนเพิ่ม) · expires_at ว่าง = ถาวร · เลิกบล็อก = ใส่ removed_*
 */
export const abuseBlocks = pgTable('abuse_blocks', {
  id: pk(), kind: text().notNull(), value: text().notNull(), label: text(), reason: text().notNull(),
  caseId: uuid().references(() => abuseCases.id, { onDelete: 'set null' }), expiresAt: tstz(),
  /** null = ระบบเพิ่มเอง */
  createdBy: uuid().references(() => staffUsers.id), createdAt: createdAt(),
  removedAt: tstz(), removedBy: uuid().references(() => staffUsers.id),
}, (t) => [uniqueIndex('abuse_blocks_active_key').on(t.kind, sql`lower(${t.value})`).where(sql`${t.removedAt} IS NULL`),
  index('abuse_blocks_created_idx').on(t.createdAt),
  check('abuse_blocks_kind_valid', oneOf(t.kind, ABUSE_BLOCK_KINDS)),
  check('abuse_blocks_ip_valid', sql`${t.kind} <> 'ip' OR ${t.value}::inet IS NOT NULL`)]);

/** คะแนนสุขภาพรายวันของลูกค้าที่จ่ายเงิน (O53) · ใช้ดู "↓14 ใน 7 วัน" และเงื่อนไข "ติดกัน N วัน" ของ Playbook · คำนวณด้วย healthScore() ของ ops-api */
export const healthDaily = pgTable('health_daily', {
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }), date: date().notNull(),
  score: smallint().notNull(), usage: smallint().notNull(), payment: smallint().notNull(), support: smallint().notNull(), growth: smallint().notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.date] }), index('health_daily_date_idx').on(t.date)]);

export const PLAYBOOK_TRIGGERS = ['usage_drop', 'overdue', 'team_shrink', 'tickets_backlog', 'renewal_low_health'] as const;

/**
 * Playbook รับมือเมื่อสุขภาพตก (O53) · trigger = { kind, threshold, days } · steps = [{ kind: email | task | wait, title, body?, days, branches? }]
 * branches ของงานคน = { reached | no_answer | will_cancel: เลขขั้นถัดไป (0-based) | 'close' } · ไม่ระบุ = ขั้นถัดไป
 */
export const playbooks = pgTable('playbooks', {
  id: pk(), key: text().notNull().unique(), name: text().notNull(), trigger: jsonb().notNull(), steps: jsonb().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean().notNull().default(true), updatedBy: uuid().references(() => staffUsers.id), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [check('playbooks_trigger_valid', sql`${t.trigger}->>'kind' IN (${sql.raw(PLAYBOOK_TRIGGERS.map((k) => `'${k}'`).join(', '))})`)]);

/** ลูกค้าหนึ่งรายใน Playbook หนึ่ง · active ได้ครั้งละหนึ่งต่อ Playbook · recovered = คะแนนฟื้น · churned = ยกเลิกแพ็กเกจ · closed = คนปิด / จบขั้น */
export const playbookRuns = pgTable('playbook_runs', {
  id: pk(), playbookId: uuid().notNull().references(() => playbooks.id, { onDelete: 'cascade' }),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  status: text().notNull().default('active'), ownerId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  stepIndex: integer().notNull().default(0), scoreAtStart: smallint(),
  startedAt: tstz().notNull().defaultNow(), closedAt: tstz(), closeReason: text(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('playbook_runs_active_key').on(t.playbookId, t.workspaceId).where(sql`${t.status} = 'active'`),
  index('playbook_runs_status_idx').on(t.status, t.closedAt), index('playbook_runs_workspace_idx').on(t.workspaceId),
  check('playbook_runs_status_valid', oneOf(t.status, ['active', 'recovered', 'churned', 'closed'])),
  check('playbook_runs_closed', sql`(${t.status} = 'active') = (${t.closedAt} IS NULL)`)]);

/** ขั้นที่เกิดขึ้นจริงของแต่ละ run · งานของคนมีผู้รับผิดชอบและวันครบกำหนด · outcome ของงานโทร = reached | no_answer | will_cancel */
export const playbookRunSteps = pgTable('playbook_run_steps', {
  id: pk(), runId: uuid().notNull().references(() => playbookRuns.id, { onDelete: 'cascade' }),
  stepIndex: integer().notNull(), kind: text().notNull(), title: text().notNull(),
  assigneeId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), dueOn: date(),
  status: text().notNull().default('pending'), outcome: text(), note: text(),
  doneAt: tstz(), doneBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
}, (t) => [index('playbook_run_steps_run_idx').on(t.runId, t.stepIndex), index('playbook_run_steps_due_idx').on(t.status, t.dueOn),
  check('playbook_run_steps_kind_valid', oneOf(t.kind, ['email', 'task', 'wait'])),
  check('playbook_run_steps_status_valid', oneOf(t.status, ['pending', 'done', 'skipped'])),
  check('playbook_run_steps_outcome_valid', sql`${t.outcome} IS NULL OR ${t.outcome} IN ('reached', 'no_answer', 'will_cancel', 'sent', 'recovered', 'waited')`)]);

export const LEAD_STAGES = ['new', 'contacted', 'demo', 'proposal', 'won', 'lost'] as const;
export const LEAD_LOST_REASONS = ['price', 'missing_feature', 'competitor', 'no_budget', 'silent'] as const;

/**
 * Lead และดีลขายองค์กร (O54) · source: form = ฟอร์มติดต่อฝ่ายขายบนเว็บ · trial = ลูกค้าทดลองที่เข้าเกณฑ์ · manual = ทีมเพิ่มเอง
 * value_satang = มูลค่าคาดการณ์ต่อปี · next_* = ทำต่อเมื่อไร (บังคับทุกครั้งที่บันทึก กันดีลค้างเงียบ) · consent_at = ยินยอมให้ติดต่อกลับ (PDPA)
 * แพ้แล้วเก็บ 2 ปีแล้วลบ (นโยบายการเก็บข้อมูล)
 */
export const leads = pgTable('leads', {
  id: pk(), number: integer().generatedAlwaysAsIdentity().notNull().unique(),
  company: text().notNull(), contactName: text(), contactTitle: text(), email: text(), phone: text(),
  teamSize: integer(), needs: text().array().notNull().default(sql`'{}'`), message: text(),
  source: text().notNull(), stage: text().notNull().default('new'), lostReason: text(),
  valueSatang: bigint({ mode: 'number' }), seats: integer(),
  ownerId: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  nextAction: text(), nextAt: date(),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'set null' }),
  accountId: uuid().references(() => customerAccounts.id, { onDelete: 'set null' }),
  consentAt: tstz(), ip: text(),
  contactedAt: tstz(), closedAt: tstz(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('leads_stage_idx').on(t.stage, t.nextAt), uniqueIndex('leads_workspace_key').on(t.workspaceId).where(sql`${t.workspaceId} IS NOT NULL`),
  index('leads_email_idx').on(sql`lower(${t.email})`),
  check('leads_source_valid', oneOf(t.source, ['form', 'trial', 'manual'])),
  check('leads_stage_valid', oneOf(t.stage, LEAD_STAGES)),
  check('leads_lost_reason', sql`(${t.stage} = 'lost') = (${t.lostReason} IS NOT NULL) AND (${t.lostReason} IS NULL OR ${t.lostReason} IN (${sql.raw(LEAD_LOST_REASONS.map((r) => `'${r}'`).join(', '))}))`),
  check('leads_closed', sql`(${t.stage} IN ('won', 'lost')) = (${t.closedAt} IS NOT NULL)`)]);

/** บันทึกการคุยของ Lead · system = ระบบบันทึกเอง (เปลี่ยนขั้น ฟอร์มซ้ำ) */
export const leadNotes = pgTable('lead_notes', {
  id: pk(), leadId: uuid().notNull().references(() => leads.id, { onDelete: 'cascade' }),
  kind: text().notNull(), body: text().notNull(), nextAction: text(), nextAt: date(),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(),
}, (t) => [index('lead_notes_lead_idx').on(t.leadId, t.createdAt), check('lead_notes_kind_valid', oneOf(t.kind, ['call', 'email', 'meeting', 'note', 'system']))]);

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;

/**
 * ใบเสนอราคา / สัญญารายปี (O55) · เลขที่ QT-ปปดด-nnnn (ปี ค.ศ. 2 หลัก แบบเดียวกับใบแจ้งหนี้) · ราคาเป็นสตางค์ต่อที่นั่งต่อเดือน
 * ส่วนลดเกินวงเงินของคนทำ = ต้องอนุมัติก่อนส่ง (approved_at) · แก้ราคาหลังอนุมัติ = ล้างการอนุมัติ
 * ลูกค้าเปิดลิงก์ด้วย token (เก็บ hash) ไม่ต้องล็อกอิน · ตอบรับแล้ว ops-api ตั้งสัญญา สิทธิ์ SLA ใบแจ้งหนี้ ให้ทีละขั้น (setup = { step: { status, at, error } })
 */
export const quotes = pgTable('quotes', {
  id: pk(), number: text().notNull().unique(),
  accountId: uuid().notNull().references(() => customerAccounts.id), leadId: uuid().references(() => leads.id, { onDelete: 'set null' }),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'set null' }),
  status: text().notNull().default('draft'),
  planCode: text().notNull().default('enterprise'), seats: integer().notNull(), months: smallint().notNull(),
  pricePerSeatSatang: bigint({ mode: 'number' }).notNull(), listPerSeatSatang: bigint({ mode: 'number' }).notNull(),
  subtotalSatang: bigint({ mode: 'number' }).notNull(), vatSatang: bigint({ mode: 'number' }).notNull(), totalSatang: bigint({ mode: 'number' }).notNull(),
  entitlements: jsonb().notNull().default(sql`'{}'::jsonb`), sla: jsonb(), contractStart: date(), validUntil: date().notNull(),
  approvedAt: tstz(), approvedBy: uuid().references(() => staffUsers.id), approvalRequestId: uuid().references((): AnyPgColumn => approvalRequests.id),
  tokenHash: text().unique(), sentAt: tstz(), viewCount: integer().notNull().default(0), lastViewedAt: tstz(),
  acceptedAt: tstz(), acceptance: jsonb(), changeRequest: text(), setup: jsonb().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('quotes_status_idx').on(t.status, t.validUntil), index('quotes_account_idx').on(t.accountId),
  check('quotes_status_valid', oneOf(t.status, QUOTE_STATUSES)),
  check('quotes_months_valid', sql`${t.months} IN (12, 24, 36)`),
  check('quotes_amounts', sql`${t.seats} > 0 AND ${t.pricePerSeatSatang} >= 0 AND ${t.totalSatang} = ${t.subtotalSatang} + ${t.vatSatang}`),
  check('quotes_accepted', sql`(${t.status} = 'accepted') = (${t.acceptedAt} IS NOT NULL)`)]);
