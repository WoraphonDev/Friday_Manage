// B. Workspace และสมาชิก · C. ปฏิทินวันหยุด
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, pk, tstz, updatedAt } from './_common.ts';
import {
  calendarSource,
  halfDay,
  holidayKind,
  invitationStatus,
  leaveSource,
  leaveStatus,
  memberStatus,
  mfaEnforcement,
  projectRole,
  requestStatus,
  workspaceRole,
  workspaceStatus,
} from './enums.ts';
import { users } from './identity.ts';

const DEFAULT_SIZE_MAP = sql`'{"XS":1,"S":3,"M":5,"L":8,"XL":12}'::jsonb`;
/** จ.–ศ. (ISO weekday 1–5) */
const DEFAULT_WORK_DAYS = sql`'{1,2,3,4,5}'::smallint[]`;

export const workspaces = pgTable(
  'workspaces',
  {
    id: pk(),
    slug: text().notNull(),
    name: text().notNull(),
    logoUrl: text(),
    /** ช่วงแรกมี region เดียว (ตัดสิน 5 พ.ย. 2569) */
    dataRegion: text().notNull().default('ap-southeast-7'),
    defaultLocale: text().notNull().default('th'),
    allowDomainJoin: boolean().notNull().default(false),
    status: workspaceStatus().notNull().default('trial'),
    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('workspaces_slug_key').on(sql`lower(${t.slug})`),
    check('workspaces_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  ],
);

/** 1:1 กับ workspace */
export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workStart: time().notNull().default('09:30'),
  workEnd: time().notNull().default('18:30'),
  workDays: smallint().array().notNull().default(DEFAULT_WORK_DAYS),
  sizeMdMap: jsonb().notNull().default(DEFAULT_SIZE_MAP),
  allowProjectOverride: boolean().notNull().default(true),
  holidayCalendarId: uuid(),
  safeMode: boolean().notNull().default(true),
  trashDays: smallint().notNull().default(30),
  archiveRetentionYears: smallint(),
  requireConsentOnFirstLogin: boolean().notNull().default(true),
  updatedAt: updatedAt(),
});

/** 1:1 กับ workspace */
export const securityPolicies = pgTable('security_policies', {
  workspaceId: uuid()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  passwordMinLength: smallint().notNull().default(10),
  passwordRequireSpecial: boolean().notNull().default(true),
  passwordRotationDays: smallint(),
  lockoutAttempts: smallint().notNull().default(5),
  lockoutMinutes: smallint().notNull().default(15),
  sessionIdleHours: smallint().notNull().default(8),
  mfaEnforcement: mfaEnforcement().notNull().default('none'),
  allowedEmailDomains: text().array().notNull().default(sql`'{}'`),
  ipAllowlist: text().array().notNull().default(sql`'{}'`),
  updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole().notNull(),
    status: memberStatus().notNull().default('active'),
    jobTitle: text(),
    department: text(),
    /** เวลาทั้งหมดของคน (ชั่วโมง/สัปดาห์) · ส่วนที่แบ่งให้โปรเจกต์อยู่ใน project_members */
    capacityHoursWeek: smallint().notNull().default(40),
    workStart: time(),
    workEnd: time(),
    workDays: smallint().array(),
    lastActiveAt: tstz(),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    workspaceRole: workspaceRole().notNull().default('member'),
    /** FK ไป projects เพิ่มใน project.ts ไม่ได้เพราะ import วน จึงตรวจที่ API */
    projectId: uuid(),
    projectRole: projectRole(),
    jobTitle: text(),
    capacityHoursWeek: smallint(),
    message: text(),
    tokenHash: text().notNull().unique(),
    expiresAt: tstz().notNull(),
    invitedBy: uuid()
      .notNull()
      .references(() => users.id),
    status: invitationStatus().notNull().default('pending'),
    acceptedUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_workspace_idx').on(t.workspaceId, t.status),
    uniqueIndex('invitations_pending_email_key')
      .on(t.workspaceId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const inviteLinks = pgTable('invite_links', {
  id: pk(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull().unique(),
  role: workspaceRole().notNull().default('member'),
  expiresAt: tstz().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  revokedAt: tstz(),
  createdAt: createdAt(),
});

/** ขอเข้าร่วม Workspace (project_id = null) หรือขอเข้าโปรเจกต์ (หน้า 403) */
export const accessRequests = pgTable('access_requests', {
  id: pk(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid(),
  status: requestStatus().notNull().default('pending'),
  decidedBy: uuid().references(() => users.id),
  decidedAt: tstz(),
  createdAt: createdAt(),
});

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    color: text(),
    leadUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique('teams_workspace_id_key').on(t.workspaceId, t.id)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    workspaceId: uuid().notNull(),
    teamId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    // ทีมต้องอยู่ Workspace เดียวกับแถวนี้ (FK ตรวจข้าม RLS จึงต้องใส่ workspace_id ใน FK)
    foreignKey({
      name: 'team_members_team_fk',
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete('cascade'),
  ],
);

export const leaves = pgTable(
  'leaves',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    leaveType: text().notNull(),
    startDate: date().notNull(),
    endDate: date().notNull(),
    halfDay: halfDay(),
    status: leaveStatus().notNull().default('pending'),
    source: leaveSource().notNull().default('manual'),
    externalRef: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('leaves_user_dates_idx').on(t.workspaceId, t.userId, t.startDate),
    check('leaves_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/** workspace_id = null คือปฏิทินของระบบ (ประกาศ ธปท.) ใช้ร่วมทุก Workspace */
export const holidayCalendars = pgTable('holiday_calendars', {
  id: pk(),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  source: calendarSource().notNull().default('custom'),
  createdAt: createdAt(),
});

export const holidays = pgTable(
  'holidays',
  {
    id: pk(),
    calendarId: uuid()
      .notNull()
      .references(() => holidayCalendars.id, { onDelete: 'cascade' }),
    date: date().notNull(),
    name: text().notNull(),
    kind: holidayKind().notNull().default('bank'),
  },
  (t) => [uniqueIndex('holidays_calendar_date_key').on(t.calendarId, t.date)],
);
