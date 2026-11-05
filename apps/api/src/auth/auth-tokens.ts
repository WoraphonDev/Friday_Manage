import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { SYSTEM_DB } from '../db/db.module.js';
import { authTimes } from './auth.config.js';
import { hmacHex, newCode6 } from './crypto.js';
import { hashToken, newToken } from './sessions.js';

const { authTokens } = schema;

export type TokenPurpose = 'verify_email' | 'reset_password' | 'change_email';

/**
 * รหัส / ลิงก์ที่ใช้ครั้งเดียว (auth_tokens) · 1 ครั้งที่ขอ = 2 แถว: ลิงก์ (token ยาว) และรหัส 6 หลัก
 * รหัส 6 หลักเก็บเป็น HMAC ที่ผูก user_id ไว้ด้วย จึงไม่ชน unique ของ token_hash ระหว่างผู้ใช้
 * ตาราง auth_tokens ให้สิทธิ์เฉพาะ friday_system (0001_rls) จึงใช้ SYSTEM_DB
 */
@Injectable()
export class AuthTokenService {
  /**
   * จำนวนครั้งที่ใส่รหัสผิดต่อผู้ใช้ · เก็บในหน่วยความจำของ process (ตารางไม่มีคอลัมน์นับ)
   * ถ้ารันหลายเครื่องควรย้ายไป Valkey (A16) · รหัสถูกยกเลิกเมื่อผิดครบ จึงเดาสุ่มไม่ได้
   */
  private readonly attempts = new Map<string, number>();

  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  private codeHash = (purpose: TokenPurpose, userId: string, code: string) => hmacHex(`code:${purpose}`, `${userId}:${code}`);

  /** ออกรหัสใหม่ และยกเลิกรหัสเดิมของเรื่องเดียวกันที่ยังไม่ได้ใช้ */
  async issue(userId: string, purpose: TokenPurpose, minutes: number, newEmail?: string, withCode = true) {
    const token = newToken();
    const code = withCode ? newCode6() : null;
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    await this.db.transaction(async (tx) => {
      await tx
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
      await tx.insert(authTokens).values({ userId, purpose, tokenHash: hashToken(token), newEmail, expiresAt });
      if (code) await tx.insert(authTokens).values({ userId, purpose, tokenHash: this.codeHash(purpose, userId, code), newEmail, expiresAt });
    });
    this.attempts.delete(`${userId}:${purpose}`);
    return { token, code };
  }

  /** วินาทีที่ต้องรอก่อนขอรหัสใหม่ได้ (0 = ขอได้เลย) */
  async resendWait(userId: string, purpose: TokenPurpose) {
    const [last] = await this.db
      .select({ createdAt: authTokens.createdAt })
      .from(authTokens)
      .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose)))
      .orderBy(desc(authTokens.createdAt))
      .limit(1);
    if (!last) return 0;
    const wait = authTimes.resendSeconds - Math.floor((Date.now() - last.createdAt.getTime()) / 1000);
    return Math.max(0, wait);
  }

  /** ดูลิงก์โดยไม่ใช้ (หน้า "ตั้งรหัสผ่านใหม่ สำหรับ …") */
  async peekLink(token: string, purposes: TokenPurpose[]) {
    const [row] = await this.db
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.tokenHash, hashToken(token)), inArray(authTokens.purpose, purposes), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())));
    return row ?? null;
  }

  /** ใช้ลิงก์ (ครั้งเดียว · UPDATE ... RETURNING กันกดซ้ำพร้อมกัน) */
  async consumeLink(token: string, purposes: TokenPurpose[]) {
    const [row] = await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.tokenHash, hashToken(token)), inArray(authTokens.purpose, purposes), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
      .returning();
    if (row) await this.retire(row.userId, row.purpose);
    return row ?? null;
  }

  /** ใช้รหัส 6 หลัก · ผิดครบ codeAttempts ครั้ง ยกเลิกรหัสทั้งหมดของเรื่องนั้น */
  async consumeCode(userId: string, purpose: TokenPurpose, code: string) {
    const key = `${userId}:${purpose}`;
    const [row] = /^\d{6}$/.test(code)
      ? await this.db
          .update(authTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(authTokens.tokenHash, this.codeHash(purpose, userId, code)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
          .returning()
      : [];
    if (row) {
      this.attempts.delete(key);
      await this.retire(userId, purpose);
      return row;
    }
    const n = (this.attempts.get(key) ?? 0) + 1;
    if (n >= authTimes.codeAttempts) {
      this.attempts.delete(key);
      await this.retire(userId, purpose);
    } else this.attempts.set(key, n);
    return null;
  }

  private async retire(userId: string, purpose: TokenPurpose) {
    await this.db
      .update(authTokens)
      .set({ usedAt: sql`now()` })
      .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
  }
}
