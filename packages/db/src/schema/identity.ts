// A. บัญชีผู้ใช้และการล็อกอิน (ระดับระบบ ไม่มี workspace_id)
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './_common.ts';
import { authTokenPurpose, identityProvider } from './enums.ts';

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    emailVerifiedAt: tstz(),
    displayName: text().notNull(),
    firstName: text(),
    lastName: text(),
    phone: text(),
    avatarUrl: text(),
    about: text(),
    locale: text().notNull().default('th'),
    /** BE = พ.ศ., CE = ค.ศ. */
    yearFormat: text().notNull().default('BE'),
    timezone: text().notNull().default('Asia/Bangkok'),
    /** null เมื่อใช้แค่ Google / Microsoft */
    passwordHash: text(),
    passwordChangedAt: tstz(),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: tstz(),
    disabledAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

/** 1 คนผูกได้หลายวิธีล็อกอิน (รองรับ SAML ภายหลัง) */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: pk(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: identityProvider().notNull(),
    providerSubject: text().notNull(),
    /** ใช้เมื่อ provider = saml / oidc · FK เพิ่มใน migration ของ SSO */
    ssoConnectionId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_identities_provider_subject_key').on(t.provider, t.providerSubject),
    index('user_identities_user_idx').on(t.userId),
  ],
);

export const mfaFactors = pgTable('mfa_factors', {
  id: pk(),
  userId: uuid().notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  type: text().notNull().default('totp'),
  secretEnc: text().notNull(),
  backupCodesHash: text().array().notNull().default(sql`'{}'`),
  enabledAt: tstz(),
  createdAt: createdAt(),
});

export const userSessions = pgTable(
  'user_sessions',
  {
    id: pk(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    deviceName: text(),
    userAgent: text(),
    ip: text(),
    location: text(),
    rememberUntil: tstz(),
    mfaTrustedUntil: tstz(),
    lastSeenAt: tstz().notNull().defaultNow(),
    revokedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId)],
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: pk(),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: authTokenPurpose().notNull(),
    tokenHash: text().notNull().unique(),
    /** อีเมลใหม่เมื่อ purpose = change_email */
    newEmail: text(),
    expiresAt: tstz().notNull(),
    usedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [index('auth_tokens_user_idx').on(t.userId)],
);

