// N. หลังบ้าน Friday · ยกเว้น support_access_grants ที่ลูกค้าเปิด/ปิดสิทธิ์เองผ่าน A31
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('staff_users_email_key').on(sql`lower(${t.email})`),
  check('staff_users_roles_valid', sql`cardinality(${t.roles}) >= 1 AND ${t.roles} <@ ARRAY[${sql.raw(STAFF_ROLES.map((r) => `'${r}'`).join(', '))}]::text[]`),
  check('staff_users_status_valid', oneOf(t.status, STAFF_STATUSES))]);

/** สิทธิ์ฉุกเฉิน: Owner เปิดบทบาทที่ไม่มีให้ตัวเองชั่วคราว */
export const staffElevations = pgTable('staff_elevations', {
  id: pk(), staffId: uuid().notNull().references(() => staffUsers.id), role: text().notNull(), reason: text().notNull(),
  startedAt: tstz().notNull().defaultNow(), endsAt: tstz().notNull(), endedAt: tstz(), endedBy: uuid().references(() => staffUsers.id),
  createdAt: createdAt(),
}, (t) => [index('staff_elevations_staff_idx').on(t.staffId, t.endsAt),
  check('staff_elevations_role_valid', oneOf(t.role, STAFF_ROLES)),
  check('staff_elevations_window', sql`${t.endsAt} > ${t.startedAt} AND ${t.endsAt} <= ${t.startedAt} + interval '1 hour'`)]);

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
  ip: text(), userAgent: text(), createdAt: createdAt(),
}, (t) => [index('staff_audit_logs_created_idx').on(t.createdAt), index('staff_audit_logs_staff_idx').on(t.staffId, t.createdAt)]);

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
  updatedAt: updatedAt(),
}, (t) => [check('support_agents_groups_valid', sql`${t.groups} <@ ARRAY[${sql.raw(SUPPORT_GROUPS.map((g) => `'${g}'`).join(', '))}]::text[]`),
  check('support_agents_presence_valid', oneOf(t.presence, SUPPORT_PRESENCE)),
  check('support_agents_cap', sql`${t.cap} IS NULL OR ${t.cap} BETWEEN 1 AND 99`)]);

/** ผู้ดูแลประจำบัญชี (Enterprise) · 1 Workspace มีผู้ดูแล 1 คน · กฎที่ส่งไป "acct" แจกให้คนนี้ */
export const supportAccountManagers = pgTable('support_account_managers', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  staffId: uuid().notNull().references(() => staffUsers.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [index('support_account_managers_staff_idx').on(t.staffId)]);

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
  createdBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  cancelledAt: tstz(), cancelledBy: uuid().references(() => staffUsers.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('announcements_due_idx').on(t.scheduledAt).where(sql`${t.sentAt} IS NULL AND ${t.cancelledAt} IS NULL`)]);

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
  lastSentAt: tstz(), createdAt: createdAt(),
}, (t) => [uniqueIndex('staff_push_subscriptions_endpoint_key').on(t.endpoint), index('staff_push_subscriptions_staff_idx').on(t.staffId)]);

/** กันส่งแจ้งเตือนเรื่องเดิมซ้ำ (เช่น คิวชำระใกล้ครบ SLA) · key = ประเภท:รหัสรายการ */
export const staffPushNotices = pgTable('staff_push_notices', {
  key: text().primaryKey(), sentAt: createdAt(),
});
