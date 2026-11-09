import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { eq, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { AppError } from '../common/errors.js';
import type { AppRequest } from '../common/request.js';
import { Mailer } from '../core/mail.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { isTestEnv, webUrl } from './auth.config.js';
import { SecurityService } from './security.service.js';

const { users, userIdentities, authTokens } = schema;

export const DEV_TOKEN_HEADER = 'x-dev-token';
export const DEV_LINK_HEADER = 'x-dev-link-token';

/**
 * ส่งรหัส / token ให้ test อ่านได้ทาง header เพราะช่วงแรกยังไม่ส่งอีเมลจริง (docs/tech-stack.md)
 * เฉพาะ NODE_ENV=test เท่านั้น · production ไม่มีทางได้ header นี้
 */
export function devToken(res: Response, values: { code?: string | null; token?: string | null }) {
  if (!isTestEnv()) return;
  if (values.code) res.setHeader(DEV_TOKEN_HEADER, values.code);
  if (values.token) res.setHeader(values.code ? DEV_LINK_HEADER : DEV_TOKEN_HEADER, values.token);
}

/** งานบัญชีที่ใช้ร่วมกันระหว่าง /auth และ /me (อีเมลแจ้ง, เปลี่ยนอีเมล, ผูกวิธีล็อกอินรหัสผ่าน) */
@Injectable()
export class AccountService {
  constructor(
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly mailer: Mailer,
    private readonly security: SecurityService,
  ) {}

  link = (path: string, token: string) => `${webUrl()}${path}?token=${encodeURIComponent(token)}`;

  /** ระบบส่งอีเมลได้จริงหรือไม่ (ตั้ง SMTP แล้ว) · ปิดอยู่ = หน้ายืนยันอีเมลให้ข้ามไปก่อนได้ */
  get emailDelivery() {
    return this.mailer.enabled;
  }

  async mail(to: string, subject: string, lines: string[]) {
    await this.mailer.send({ to, subject, text: lines.join('\n\n') });
  }

  /** ผูกวิธี "รหัสผ่าน" ให้บัญชี (ถ้ายังไม่มี) · provider_subject ของ password ใช้ user_id */
  async ensurePasswordIdentity(db: Db | Tx, userId: string) {
    await db.insert(userIdentities).values({ userId, provider: 'password', providerSubject: userId }).onConflictDoNothing();
  }

  /**
   * ใช้ token เปลี่ยนอีเมล (มาจากลิงก์หรือรหัส 6 หลัก) · ตรวจซ้ำอีกครั้งว่าอีเมลใหม่ยังว่าง
   * ใช้ friday_system เพราะต้องตรวจอีเมลของผู้ใช้ทุกคน (RLS เห็นแค่คนใน Workspace เดียวกัน)
   */
  async applyEmailChange(row: typeof authTokens.$inferSelect, req: AppRequest) {
    const newEmail = row.newEmail!.toLowerCase();
    const [old] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
    const [taken] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${newEmail} and ${users.id} <> ${row.userId}`);
    if (taken) throw new AppError(409, 'email_taken', 'อีเมลนี้มีบัญชีแล้ว');
    await this.db.update(users).set({ email: newEmail, emailVerifiedAt: new Date() }).where(eq(users.id, row.userId));
    await this.security.audit(row.userId, 'secu.email_changed', `เปลี่ยนอีเมลจาก ${old.email} เป็น ${newEmail}`, req);
    await this.mail(old.email, 'อีเมลของบัญชี Friday Manage ถูกเปลี่ยน', [
      `อีเมลสำหรับเข้าสู่ระบบถูกเปลี่ยนเป็น ${newEmail} แล้ว`,
      'ถ้าไม่ได้ทำเอง ให้ติดต่อ Admin ของ Workspace ทันที',
    ]);
    return { email: newEmail };
  }
}
