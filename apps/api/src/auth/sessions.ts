import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { userSessions, users, securityPolicies, workspaceMembers } = schema;
export const SESSION_COOKIE = 'fm_session';
export const CSRF_COOKIE = 'fm_csrf';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Session เก็บแค่ hash ของ token · ใช้ friday_system เพราะตอนนี้ยังไม่รู้ว่าเป็นใคร */
@Injectable()
export class SessionService {
  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  async create(userId: string, meta: { userAgent?: string; ip?: string; remember: boolean; mfaTrustedUntil?: Date | null }) {
    const token = newToken();
    const rememberUntil = meta.remember ? new Date(Date.now() + config.rememberDays * 86_400_000) : null;
    const [row] = await this.db
      .insert(userSessions)
      .values({
        userId,
        tokenHash: hashToken(token),
        deviceName: deviceName(meta.userAgent),
        userAgent: meta.userAgent,
        ip: meta.ip,
        rememberUntil,
        mfaTrustedUntil: meta.mfaTrustedUntil ?? null,
      })
      .returning({ id: userSessions.id });
    return { token, sessionId: row.id, rememberUntil };
  }

  /**
   * คืนผู้ใช้ถ้า Session ยังใช้ได้: ไม่ถูกยกเลิก และ (จดจำไว้ หรือยังไม่เกินเวลาว่างที่กำหนด)
   * เวลาว่าง = ค่าที่น้อยที่สุดใน security_policies ของ Workspace ที่ผู้ใช้อยู่ (ไม่มี = ค่าใน config)
   */
  async find(token: string) {
    const idleHours = sql`coalesce((
      select min(${securityPolicies.sessionIdleHours}) from ${securityPolicies}
      join ${workspaceMembers} on ${workspaceMembers.workspaceId} = ${securityPolicies.workspaceId}
      where ${workspaceMembers.userId} = ${userSessions.userId} and ${workspaceMembers.status} = 'active'
    ), ${config.sessionIdleHours})::int`;
    const [row] = await this.db
      .select({ sessionId: userSessions.id, userId: userSessions.userId })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, hashToken(token)),
          isNull(userSessions.revokedAt),
          isNull(users.disabledAt),
          sql`(${userSessions.rememberUntil} > now() or ${userSessions.lastSeenAt} > now() - make_interval(hours => ${idleHours}))`,
        ),
      );
    if (!row) return null;
    await this.db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, row.sessionId));
    return row;
  }

  async revoke(sessionId: string) {
    await this.db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, sessionId));
  }

  /** ออกจากระบบทุกเครื่อง (ยกเว้นเครื่องที่ระบุ) และเลิกจำอุปกรณ์สำหรับ 2FA · ใช้ตอนรีเซ็ต / เปลี่ยนรหัสผ่าน */
  async revokeAll(userId: string, exceptSessionId?: string) {
    const others = and(eq(userSessions.userId, userId), exceptSessionId ? ne(userSessions.id, exceptSessionId) : undefined);
    // Session ที่ออกจากระบบไปแล้วอาจยังจำอุปกรณ์อยู่ จึงล้างการจำของทุกแถว
    await this.db.update(userSessions).set({ mfaTrustedUntil: null }).where(others);
    const rows = await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(others, isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });
    return rows.length;
  }

  /** อุปกรณ์นี้ยังได้รับการจำไว้สำหรับ 2FA ถึงเมื่อไร (Session เดิมของอุปกรณ์ที่ผ่าน 2FA แล้ว) */
  async trustedUntil(sessionId: string, userId: string) {
    const [row] = await this.db
      .select({ until: userSessions.mfaTrustedUntil })
      .from(userSessions)
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId), gt(userSessions.mfaTrustedUntil, new Date())));
    return row?.until ?? null;
  }

  /** ย้ายการจำอุปกรณ์ไปอยู่กับ Session ใหม่ เพื่อให้ "ออกจากระบบเครื่องนี้" ใน Profile ยกเลิกการจำได้ด้วย */
  async setTrust(sessionId: string, until: Date | null) {
    await this.db.update(userSessions).set({ mfaTrustedUntil: until }).where(eq(userSessions.id, sessionId));
  }

  async clearTrust(userId: string) {
    await this.db.update(userSessions).set({ mfaTrustedUntil: null }).where(eq(userSessions.userId, userId));
  }
}

/** ชื่ออุปกรณ์แบบที่แสดงใน Profile ("Chrome · macOS") จาก User-Agent อย่างง่าย */
export function deviceName(ua?: string): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const name = [browser, os].filter(Boolean).join(' · ');
  return name || ua.slice(0, 60);
}
