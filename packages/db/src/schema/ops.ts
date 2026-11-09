// N. หลังบ้าน Friday · ยกเว้น support_access_grants ที่ลูกค้าเปิด/ปิดสิทธิ์เองผ่าน A31
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, smallint, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('support_tickets_queue_idx').on(t.status, t.assigneeId, t.createdAt), index('support_tickets_workspace_idx').on(t.workspaceId),
  unique('support_tickets_workspace_id_key').on(t.workspaceId, t.id),
  check('support_tickets_status_valid', oneOf(t.status, TICKET_STATUSES)),
  check('support_tickets_channel_valid', oneOf(t.channel, ['in_app', 'email', 'phone', 'line'])),
  check('support_tickets_priority_valid', oneOf(t.priority, ['low', 'normal', 'high', 'urgent'])),
  check('support_tickets_requester', sql`${t.requesterUserId} IS NOT NULL OR ${t.requesterEmail} IS NOT NULL`),
  check('support_tickets_csat', sql`${t.csat} IS NULL OR ${t.csat} BETWEEN 1 AND 5`)]);

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
  createdAt: createdAt(),
}, (t) => [index('support_sessions_workspace_idx').on(t.workspaceId, t.startedAt),
  foreignKey({ name: 'support_sessions_ticket_fk', columns: [t.workspaceId, t.ticketId], foreignColumns: [supportTickets.workspaceId, supportTickets.id] }),
  check('support_sessions_write_approval', sql`${t.mode} <> 'write' OR (${t.secondApproverId} IS NOT NULL AND ${t.secondApproverId} <> ${t.staffId})`),
  check('support_sessions_dates', sql`${t.endedAt} >= ${t.startedAt}`)]);

export const featureFlags = pgTable('feature_flags', {
  id: pk(), key: text().notNull().unique(), description: text(), defaultOn: boolean().notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  id: pk(), flagId: uuid().notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(), enabled: boolean().notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('feature_flag_overrides_key').on(t.flagId, t.workspaceId)]);

export const announcements = pgTable('announcements', {
  id: pk(), message: text().notNull(), audience: announcementAudience().notNull().default('all'),
  channels: text().array().notNull().default(sql`'{banner}'`), scheduledAt: tstz(), sentAt: tstz(),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

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

