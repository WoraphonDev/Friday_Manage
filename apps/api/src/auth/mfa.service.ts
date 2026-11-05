import { Injectable } from '@nestjs/common';
import { type Db, schema, type Tx } from '@friday/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { decryptSecret, hmacHex, newBackupCode, normalizeBackupCode, verifyTotp } from './crypto.js';

const { mfaFactors } = schema;

export const BACKUP_CODE_COUNT = 10;

export type MfaCheck = { method: 'totp' } | { method: 'backup'; backupCodesLeft: number };

/**
 * ตรวจรหัส 2FA (TOTP หรือ Backup code) · รับ db จากผู้เรียก:
 * Login ยังไม่มี Session จึงส่ง SYSTEM_DB · หน้า Profile ส่ง tx จาก TenantDb.run
 */
@Injectable()
export class MfaService {
  /**
   * step ล่าสุดที่ใช้แล้วต่อผู้ใช้ กันเอารหัสเดิมมาใช้ซ้ำภายใน 30 วินาที
   * เก็บในหน่วยความจำ (ตาราง mfa_factors ไม่มีคอลัมน์นี้) · หลายเครื่องควรย้ายไป Valkey (A16)
   */
  private readonly lastStep = new Map<string, number>();

  backupHash = (userId: string, code: string) => hmacHex('backup-code', `${userId}:${normalizeBackupCode(code)}`);

  newBackupCodes(userId: string) {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
    return { codes, hashes: codes.map((c) => this.backupHash(userId, c)) };
  }

  async factor(db: Db | Tx, userId: string) {
    const [f] = await db.select().from(mfaFactors).where(eq(mfaFactors.userId, userId));
    return f ?? null;
  }

  async isEnabled(db: Db | Tx, userId: string) {
    const f = await this.factor(db, userId);
    return !!f?.enabledAt;
  }

  /** ตรวจรหัส TOTP กับ secret ที่เข้ารหัสไว้ (ใช้ได้ทั้งตอนเปิดใช้และตอน Login) */
  checkTotp(userId: string, secretEnc: string, code: string) {
    const step = verifyTotp(decryptSecret(secretEnc), code);
    if (step === null) return false;
    if (step <= (this.lastStep.get(userId) ?? -1)) return false;
    this.lastStep.set(userId, step);
    return true;
  }

  /** ตรวจรหัสของ factor ที่เปิดใช้แล้ว · Backup code ใช้ได้ครั้งเดียว (ลบออกจาก array แบบ atomic) */
  async verify(db: Db | Tx, userId: string, rawCode: string): Promise<MfaCheck | null> {
    const code = rawCode.trim().replace(/\s/g, '');
    const f = await this.factor(db, userId);
    if (!f?.enabledAt) return null;
    if (/^\d{6}$/.test(code)) return this.checkTotp(userId, f.secretEnc, code) ? { method: 'totp' } : null;
    if (normalizeBackupCode(code).length !== 10) return null;
    const h = this.backupHash(userId, code);
    const [row] = await db
      .update(mfaFactors)
      .set({ backupCodesHash: sql`array_remove(${mfaFactors.backupCodesHash}, ${h})` })
      .where(and(eq(mfaFactors.userId, userId), isNotNull(mfaFactors.enabledAt), sql`${h} = any(${mfaFactors.backupCodesHash})`))
      .returning({ left: sql<number>`cardinality(${mfaFactors.backupCodesHash})` });
    return row ? { method: 'backup', backupCodesLeft: Number(row.left) } : null;
  }

  forget(userId: string) {
    this.lastStep.delete(userId);
  }
}
