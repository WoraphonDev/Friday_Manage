import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors.js';
import type { AppRequest } from '../common/request.js';
import { config } from '../config.js';
import { SYSTEM_DB } from '../db/db.module.js';

const { securityPolicies, workspaceMembers, workspaces, auditLogs } = schema;

export interface EffectivePolicy {
  lockoutAttempts: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  passwordRequireSpecial: boolean;
  sessionIdleHours: number;
  /** มี Workspace ที่บังคับ 2FA กับผู้ใช้คนนี้ */
  mfaRequired: boolean;
}

/** J2: กติกาขั้นต่ำของรหัสผ่านทุกบัญชี (ก่อนมี Workspace) */
const BASE_MIN_LENGTH = 8;

/**
 * นโยบายความปลอดภัยของผู้ใช้ = ค่าที่เข้มที่สุดจากทุก Workspace ที่เป็นสมาชิก active
 * ใช้ friday_system เพราะต้องอ่านข้ามหลาย Workspace และบางจุดยังไม่รู้ว่าผู้ใช้เป็นใคร (Login)
 */
@Injectable()
export class SecurityService {
  constructor(@Inject(SYSTEM_DB) private readonly db: Db) {}

  async policyFor(userId: string): Promise<EffectivePolicy> {
    const [row] = await this.db
      .select({
        attempts: sql<number | null>`min(${securityPolicies.lockoutAttempts})`,
        minutes: sql<number | null>`max(${securityPolicies.lockoutMinutes})`,
        minLength: sql<number | null>`max(${securityPolicies.passwordMinLength})`,
        special: sql<boolean | null>`bool_or(${securityPolicies.passwordRequireSpecial})`,
        idle: sql<number | null>`min(${securityPolicies.sessionIdleHours})`,
        mfa: sql<boolean | null>`bool_or(${securityPolicies.mfaEnforcement} = 'all' or (${securityPolicies.mfaEnforcement} = 'admin' and ${workspaceMembers.role} in ('owner', 'admin')))`,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .innerJoin(securityPolicies, eq(securityPolicies.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'), isNull(workspaces.deletedAt)));
    return {
      lockoutAttempts: Number(row?.attempts ?? config.lockoutAttempts),
      lockoutMinutes: Number(row?.minutes ?? config.lockoutMinutes),
      passwordMinLength: Math.max(BASE_MIN_LENGTH, Number(row?.minLength ?? BASE_MIN_LENGTH)),
      passwordRequireSpecial: !!row?.special,
      sessionIdleHours: Number(row?.idle ?? config.sessionIdleHours),
      mfaRequired: !!row?.mfa,
    };
  }

  /** ตรวจรหัสผ่านใหม่ตามนโยบาย · ผิดตอบ 400 รูปแบบเดียวกับ parse() */
  async assertPassword(userId: string, password: string, field: string) {
    const p = await this.policyFor(userId);
    const problems: string[] = [];
    if (password.length < p.passwordMinLength) problems.push(`อย่างน้อย ${p.passwordMinLength} ตัวอักษร`);
    if (!/[A-Z]/.test(password)) problems.push('ต้องมีตัวพิมพ์ใหญ่');
    if (!/[0-9]/.test(password)) problems.push('ต้องมีตัวเลข');
    if (p.passwordRequireSpecial && !/[^A-Za-z0-9]/.test(password)) problems.push('ต้องมีอักขระพิเศษ');
    if (password.length > 200) problems.push('ยาวเกิน 200 ตัวอักษร');
    if (problems.length) {
      throw new AppError(400, 'invalid_input', 'ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง', {
        fields: problems.map((message) => ({ path: field, message })),
        policy: { minLength: p.passwordMinLength, requireSpecial: p.passwordRequireSpecial },
      });
    }
  }

  /**
   * Audit หมวด secu ของผู้ใช้ลงทุก Workspace ที่เป็นสมาชิก เพื่อให้ Admin แต่ละที่เห็นใน Admin Console
   * ผู้ใช้ที่ยังไม่มี Workspace ไม่มีที่ให้บันทึก (ตาราง audit_logs ผูก workspace_id)
   */
  async audit(userId: string, action: `secu.${string}`, summary: string, req?: AppRequest, actorId: string | null = userId) {
    const rows = await this.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active'), isNull(workspaces.deletedAt)));
    if (!rows.length) return;
    await this.db.insert(auditLogs).values(
      rows.map((r) => ({
        workspaceId: r.workspaceId,
        actorId,
        actorKind: actorId ? ('user' as const) : ('system' as const),
        category: 'secu' as const,
        action,
        targetType: 'user',
        targetId: userId,
        summary,
        ip: req?.ip,
        userAgent: req?.get('user-agent'),
      })),
    );
  }
}
