import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { userSessions, users } = schema;
export const SESSION_COOKIE = 'fm_session';
export const CSRF_COOKIE = 'fm_csrf';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Session เก็บแค่ hash ของ token · ใช้ friday_system เพราะตอนนี้ยังไม่รู้ว่าเป็นใคร */
@Injectable()
export class SessionService {
  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  async create(userId: string, meta: { userAgent?: string; ip?: string; remember: boolean }) {
    const token = newToken();
    const rememberUntil = meta.remember ? new Date(Date.now() + config.rememberDays * 86_400_000) : null;
    const [row] = await this.db
      .insert(userSessions)
      .values({ userId, tokenHash: hashToken(token), userAgent: meta.userAgent, ip: meta.ip, rememberUntil })
      .returning({ id: userSessions.id });
    return { token, sessionId: row.id, rememberUntil };
  }

  /** คืนผู้ใช้ถ้า Session ยังใช้ได้: ไม่ถูกยกเลิก และ (จดจำไว้ หรือยังไม่เกินเวลาว่างที่กำหนด) */
  async find(token: string) {
    const [row] = await this.db
      .select({ sessionId: userSessions.id, userId: userSessions.userId })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, hashToken(token)),
          isNull(userSessions.revokedAt),
          isNull(users.disabledAt),
          sql`(${userSessions.rememberUntil} > now() or ${userSessions.lastSeenAt} > now() - make_interval(hours => ${config.sessionIdleHours}))`,
        ),
      );
    if (!row) return null;
    await this.db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, row.sessionId));
    return row;
  }

  async revoke(sessionId: string) {
    await this.db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, sessionId));
  }
}
