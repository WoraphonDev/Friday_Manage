import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/** แถวที่สคริปต์จะเปลี่ยน · before / after = ค่าของคอลัมน์ที่ประกาศไว้ (ใช้ทั้งทดลองรัน รันจริง และย้อนกลับ) */
export interface Target {
  id: string;
  label: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
export interface Field {
  key: string;
  kind: 'project' | 'number' | 'date';
  min?: number;
  max?: number;
  optional?: boolean;
}

/**
 * สคริปต์ดูแลข้อมูล (O56) · เพิ่มตัวใหม่ = เพิ่มไฟล์ / รายการในโค้ดผ่าน PR เท่านั้น (ไม่มีช่องพิมพ์ SQL)
 * แบบประกาศ: ตาราง + คอลัมน์ที่แตะ + query หาแถวที่ต้องเปลี่ยนพร้อมค่าก่อน / หลัง · ตัวรันเขียนค่า after ทีละชุดและเก็บ before ไว้ย้อนกลับ
 * ops-api ข้าม RLS จึงต้องกรอง workspace_id ทุก query เอง (ทุก targets() รับ workspaceId)
 */
export interface MaintenanceScript<P = Record<string, unknown>> {
  key: string;
  table: 'user_sessions' | 'invitations' | 'issues';
  columns: string[];
  undoable: boolean;
  params: z.ZodType<P>;
  fields: Field[];
  /** query ของแถวเป้าหมาย · ต้องคืน id, label, before (jsonb), after (jsonb) */
  targets: (workspaceId: string, p: P) => SQL;
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const staleSessions: MaintenanceScript<{ days: number }> = {
  key: 'revoke_stale_sessions',
  table: 'user_sessions',
  columns: ['revoked_at'],
  undoable: true,
  params: z.object({ days: z.number().int().min(7).max(365) }).strict(),
  fields: [{ key: 'days', kind: 'number', min: 7, max: 365 }],
  // session ของสมาชิก Workspace นี้ที่ไม่ได้ใช้เกิน N วัน (ผู้ใช้ต้องเข้าสู่ระบบใหม่) · ไม่แตะ session ที่ยกเลิกแล้ว
  targets: (ws, p) => sql`
    select s.id, u.email || ' · ' || coalesce(s.device_name, left(coalesce(s.user_agent, '-'), 40)) || ' · ใช้ล่าสุด ' || to_char(s.last_seen_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as label,
      jsonb_build_object('revoked_at', null) as before, jsonb_build_object('revoked_at', now()) as after
    from user_sessions s join users u on u.id = s.user_id
    where s.revoked_at is null and s.last_seen_at < now() - (${p.days}::int || ' days')::interval
      and s.user_id in (select m.user_id from workspace_members m where m.workspace_id = ${ws}::uuid)
    order by s.last_seen_at`,
};

const staleInvites: MaintenanceScript<Record<string, never>> = {
  key: 'expire_stale_invitations',
  table: 'invitations',
  columns: ['status'],
  undoable: true,
  params: z.object({}).strict() as z.ZodType<Record<string, never>>,
  fields: [],
  targets: (ws) => sql`
    select i.id, i.email || ' · หมดอายุ ' || to_char(i.expires_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as label,
      jsonb_build_object('status', i.status) as before, jsonb_build_object('status', 'expired') as after
    from invitations i where i.workspace_id = ${ws}::uuid and i.status = 'pending' and i.expires_at < now() order by i.expires_at`,
};

const shiftPlan: MaintenanceScript<{ projectKey: string; days: number; createdOn?: string }> = {
  key: 'shift_plan_dates',
  table: 'issues',
  columns: ['plan_start', 'plan_end'],
  undoable: true,
  params: z
    .object({ projectKey: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'รหัสโปรเจกต์ไม่ถูกต้อง'), days: z.number().int().min(-365).max(365).refine((n) => n !== 0, 'ต้องไม่เป็น 0'), createdOn: iso.optional() })
    .strict(),
  fields: [{ key: 'projectKey', kind: 'project' }, { key: 'days', kind: 'number', min: -365, max: 365 }, { key: 'createdOn', kind: 'date', optional: true }],
  // เลื่อนวันแผนทั้งเริ่มและจบเท่ากัน (ช่วงงานเท่าเดิม) · ไม่คำนวณวันทำการ / Man-Day ใหม่และไม่ส่งแจ้งเตือน (บอกไว้ในคำอธิบาย)
  targets: (ws, p) => sql`
    select i.id, pr.key || '-' || i.number || ' ' || left(i.title, 60) as label,
      jsonb_build_object('plan_start', i.plan_start, 'plan_end', i.plan_end) as before,
      jsonb_build_object('plan_start', i.plan_start + ${p.days}::int, 'plan_end', i.plan_end + ${p.days}::int) as after
    from issues i join projects pr on pr.id = i.project_id
    where i.workspace_id = ${ws}::uuid and pr.workspace_id = ${ws}::uuid and pr.key = ${p.projectKey} and pr.deleted_at is null and i.deleted_at is null
      and i.plan_start is not null and i.plan_end is not null
      ${p.createdOn ? sql`and (i.created_at at time zone 'Asia/Bangkok')::date = ${p.createdOn}::date` : sql``}
    order by i.number`,
};

export const SCRIPTS: MaintenanceScript[] = [staleSessions, staleInvites, shiftPlan] as unknown as MaintenanceScript[];
export const scriptOf = (key: string) => SCRIPTS.find((s) => s.key === key);
