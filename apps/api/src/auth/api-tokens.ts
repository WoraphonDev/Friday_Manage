import { createHash, randomBytes } from 'node:crypto';
import { type Db, schema } from '@friday/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors.js';

const s = schema;

export const TOKEN_PREFIX = 'fmt_';
/** read = GET / HEAD เท่านั้น · write = ทุก method (รวม read) */
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const newApiToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
export const hashApiToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface TokenIdentity {
  tokenId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}

/**
 * ส่วนของ Workspace ที่ token เข้าไม่ได้ ไม่ว่ามี scope ไหน (จัดการ token เอง, ช่องทางแจ้งเตือน, แพ็กเกจ, สมาชิก, ลิงก์เชิญ ฯลฯ)
 * เหตุผล: token หลุดแล้วต้องยกระดับตัวเองหรือเปลี่ยนการตั้งค่าความปลอดภัยไม่ได้
 */
const BLOCKED_WORKSPACE_AREAS = /^(api-tokens|channels|billing|members|invitations|invite-links|access-requests|notification-templates|saved-searches|leaves|me)(\/|$)/;

/**
 * ตรวจ Bearer token แล้วคืนตัวตนของผู้สร้าง token (สิทธิ์จริงของคำขอ = สิทธิ์ของผู้สร้างใน Workspace นั้น ∩ scopes ตาม 04-permissions ข้อ 9)
 * คืน null เมื่อ token ไม่รู้จัก / ยกเลิกแล้ว / ผู้สร้างไม่ได้เป็นสมาชิก active แล้ว / บัญชีผู้สร้างถูกปิด
 */
export async function findApiToken(db: Db, token: string): Promise<TokenIdentity | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ id: s.apiTokens.id, workspaceId: s.apiTokens.workspaceId, scopes: s.apiTokens.scopes, createdBy: s.apiTokens.createdBy, member: s.workspaceMembers.userId, wsDeleted: s.workspaces.deletedAt, userDisabled: s.users.disabledAt })
    .from(s.apiTokens)
    .innerJoin(s.workspaces, eq(s.workspaces.id, s.apiTokens.workspaceId))
    // บัญชีที่ถูกปิดทั้งระบบต้องใช้ token ไม่ได้ เหมือน session (สมาชิก Workspace อาจยัง active อยู่)
    .innerJoin(s.users, eq(s.users.id, s.apiTokens.createdBy))
    .leftJoin(s.workspaceMembers, and(eq(s.workspaceMembers.workspaceId, s.apiTokens.workspaceId), eq(s.workspaceMembers.userId, s.apiTokens.createdBy), eq(s.workspaceMembers.status, 'active')))
    .where(and(eq(s.apiTokens.tokenHash, hashApiToken(token)), isNull(s.apiTokens.revokedAt)));
  if (!row || !row.member || row.wsDeleted || row.userDisabled) return null;
  // บันทึกการใช้ล่าสุดไม่เกินนาทีละครั้ง (ไม่ให้ทุกคำขอเขียนฐานข้อมูล)
  void db
    .update(s.apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(s.apiTokens.id, row.id), or(isNull(s.apiTokens.lastUsedAt), sql`${s.apiTokens.lastUsedAt} < now() - interval '1 minute'`)))
    .catch(() => undefined);
  return { tokenId: row.id, userId: row.createdBy, workspaceId: row.workspaceId, scopes: row.scopes };
}

/** กติกาของ token ต่อคำขอ: ใช้ได้เฉพาะ `/api/v1/w/{workspace ของ token}/…` ที่ไม่ใช่ส่วนอ่อนไหว และ scope ต้องพอกับ method */
export async function assertTokenAllowed(db: Db, id: TokenIdentity, method: string, path: string) {
  const m = /^\/api\/v1\/w\/([^/]+)(?:\/(.*))?$/.exec(path);
  const read = method === 'GET' || method === 'HEAD';
  // ข้อมูลของตัวเอง (ตรวจว่า token ใช้ได้) เป็นข้อยกเว้นเดียวนอก Workspace
  if (!m) {
    if (read && path === '/api/v1/me') return;
    throw new AppError(403, 'token_not_allowed', 'API token ใช้ได้เฉพาะ API ของ Workspace ที่สร้าง token', { path });
  }
  const [ws] = await db.select({ id: s.workspaces.id }).from(s.workspaces).where(sql`lower(${s.workspaces.slug}) = ${decodeURIComponent(m[1]!).toLowerCase()}`);
  if (!ws || ws.id !== id.workspaceId) throw new AppError(403, 'token_workspace_mismatch', 'API token นี้ใช้กับ Workspace อื่นไม่ได้');
  if (BLOCKED_WORKSPACE_AREAS.test(m[2] ?? '')) throw new AppError(403, 'token_not_allowed', 'API token เรียกส่วนนี้ไม่ได้ (ตั้งค่า, สมาชิก, แพ็กเกจ หรือการจัดการ token)', { area: (m[2] ?? '').split('/')[0] });
  const need: TokenScope = read ? 'read' : 'write';
  const has = need === 'read' ? id.scopes.includes('read') || id.scopes.includes('write') : id.scopes.includes('write');
  if (!has) throw new AppError(403, 'insufficient_scope', `API token นี้ไม่มี scope "${need}"`, { required: need, scopes: id.scopes });
}
