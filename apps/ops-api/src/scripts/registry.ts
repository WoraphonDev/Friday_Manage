import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '@friday/db';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { sqlRows } from '../sql-rows.js';
import { renderInvitationEmail } from './invitation-mail.js';

/** แถวที่สคริปต์จะเปลี่ยน · before / after = ค่าของคอลัมน์ที่ประกาศไว้ (ใช้ทั้งทดลองรัน รันจริง และย้อนกลับ) */
export interface Target {
  id: string;
  label: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
export interface Field {
  key: string;
  kind: 'project' | 'number' | 'date' | 'text';
  min?: number;
  max?: number;
  optional?: boolean;
}

/** ของที่สคริปต์แบบเขียนเอง (apply) ใช้ได้ · ops-api ข้าม RLS จึงต้องกรอง workspace_id เองทุก query */
export interface ApplyContext {
  tx: Tx;
  workspaceId: string;
  appUrl: string;
}
export interface SendMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}
/** งานหลัง commit (เช่น ส่งอีเมล) · ล้มแล้วไม่ย้อนแถวที่ commit แล้ว แต่ต้องบันทึกผลเอง */
export interface AfterCommit {
  mail?: SendMail;
  /** บันทึกผลส่ง · disabled = ไม่ได้ตั้ง SMTP ไม่มีอีเมลออกจริง */
  record?: (status: 'sent' | 'failed' | 'disabled', error: string | null) => SQL;
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
  /**
   * เขียนเองแทนการตั้งค่าคอลัมน์ตาม after · ใช้กับงานที่ย้อนไม่ได้ (เช่น ออก token ใหม่แล้วส่งอีเมล) จึงต้อง undoable: false
   * รันในธุรกรรมของชุด · คืนงานที่ต้องทำหลัง commit
   */
  apply?: (ctx: ApplyContext, t: Target) => Promise<AfterCommit | void>;
  /** ส่งอีเมล · ไม่ได้ตั้ง SMTP ของ Ops = ทดลองรันไม่ได้ (รันไปก็ไม่มีอีเมลออก) */
  sendsMail?: boolean;
  /**
   * ให้ API ทำแทนผ่านคิวงาน (ตรรกะซับซ้อนที่ต้องเหมือนหน้าเว็บทุกอย่าง) · targets / apply ไม่ใช้
   * issue_move = ย้ายงานข้ามโปรเจกต์ (apps/api/src/issue-move/issue-move.jobs.ts)
   */
  remote?: 'issue_move';
  params: z.ZodType<P>;
  fields: Field[];
  /** query ของแถวเป้าหมาย · ต้องคืน id, label, before (jsonb), after (jsonb) */
  targets: (workspaceId: string, p: P) => SQL;
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const projectKey = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'รหัสโปรเจกต์ไม่ถูกต้อง');

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
    .object({ projectKey, days: z.number().int().min(-365).max(365).refine((n) => n !== 0, 'ต้องไม่เป็น 0'), createdOn: iso.optional() })
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

/**
 * วันทำการถัดไป (รวมวันนั้นเอง) ตามวันทำงานของ Workspace + ปฏิทินวันหยุด (ของโปรเจกต์ หรือของ Workspace) + วันหยุดเฉพาะโปรเจกต์
 * ตรรกะเดียวกับ WorkCalendar.onOrAfter ของ API · ดูไปข้างหน้าไม่เกิน 60 วัน (ไม่เจอ = คงวันเดิม)
 */
const nextWorkDay = (d: SQL) => sql`coalesce((
    select min(x)::date from generate_series(${d}::timestamp, ${d}::timestamp + interval '60 days', interval '1 day') x
    where extract(isodow from x)::int = any(cal.wd) and x::date not in (select date from off)
  ), ${d})`;

const holidayShift: MaintenanceScript<{ projectKey: string; from?: string }> = {
  key: 'shift_off_holidays',
  table: 'issues',
  columns: ['plan_start', 'plan_end'],
  undoable: true,
  params: z.object({ projectKey, from: iso.optional() }).strict(),
  fields: [{ key: 'projectKey', kind: 'project' }, { key: 'from', kind: 'date', optional: true }],
  // หลังเพิ่มวันหยุดใหม่ (เช่น วันหยุดพิเศษตามมติ ครม.) วันแผนที่ตกวันหยุดเลื่อนไปวันทำการถัดไป
  // เฉพาะงานที่ยังไม่เสร็จและวันที่ตั้งแต่ from (ค่าเริ่มต้นวันนี้) · วันที่ผ่านไปแล้วไม่แตะ · ไม่คำนวณ Man-Day ใหม่และไม่ส่งแจ้งเตือน
  // เลื่อนไปข้างหน้าทั้งคู่จึงยังเริ่ม ≤ จบเสมอ
  targets: (ws, p) => {
    const from = p.from ? sql`${p.from}::date` : sql`(now() at time zone 'Asia/Bangkok')::date`;
    return sql`
    with cal as (
      select pr.id as project_id, coalesce(st.work_days, array[1, 2, 3, 4, 5]::smallint[]) as wd, coalesce(pr.holiday_calendar_id, st.holiday_calendar_id) as calendar_id
      from projects pr left join workspace_settings st on st.workspace_id = pr.workspace_id
      where pr.workspace_id = ${ws}::uuid and pr.key = ${p.projectKey} and pr.deleted_at is null
    ), off as (
      select h.date from holidays h join cal on h.calendar_id = cal.calendar_id
      union select ph.date from project_holidays ph join cal on ph.project_id = cal.project_id where ph.workspace_id = ${ws}::uuid
    ), moved as (
      select i.id, pr.key || '-' || i.number || ' ' || left(i.title, 60) as label, i.number, i.plan_start, i.plan_end,
        case when i.plan_start >= ${from} then ${nextWorkDay(sql`i.plan_start`)} else i.plan_start end as new_start,
        case when i.plan_end >= ${from} then ${nextWorkDay(sql`i.plan_end`)} else i.plan_end end as new_end
      from issues i join projects pr on pr.id = i.project_id join cal on cal.project_id = i.project_id
        join workflow_statuses wst on wst.id = i.status_id
      where i.workspace_id = ${ws}::uuid and i.deleted_at is null and wst.category <> 'done'
        and i.plan_start is not null and i.plan_end is not null and i.plan_end >= ${from}
    )
    select id, label, jsonb_build_object('plan_start', plan_start, 'plan_end', plan_end) as before, jsonb_build_object('plan_start', new_start, 'plan_end', new_end) as after
    from moved where new_start <> plan_start or new_end <> plan_end order by number`;
  },
};

// token แบบเดียวกับ apps/api/src/auth/sessions.ts (ลิงก์ /join/<token> ตรวจด้วย sha256 hex)
const newToken = () => randomBytes(32).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const resendInvites: MaintenanceScript<Record<string, never>> = {
  key: 'resend_failed_invitations',
  table: 'invitations',
  columns: ['token_hash', 'expires_at', 'email_status'],
  // ส่งอีเมลออกไปแล้วเรียกคืนไม่ได้ และ token เดิมใช้ไม่ได้แล้ว
  undoable: false,
  sendsMail: true,
  params: z.object({}).strict() as z.ZodType<Record<string, never>>,
  fields: [],
  // คำเชิญที่ยังรอตอบรับแต่ส่งอีเมลไม่ผ่าน (เช่น SMTP ล่มตอนเชิญ) · ต่ออายุเท่าที่ตั้งตอนเชิญ (ขั้นต่ำ 7 วัน) แบบเดียวกับปุ่มส่งซ้ำของ API
  targets: (ws) => sql`
    select i.id, i.email || ' · ส่งไม่ผ่าน ' || coalesce(to_char(i.email_attempted_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI'), '-') || coalesce(' · ' || left(i.email_error, 60), '') as label,
      jsonb_build_object('expires_at', i.expires_at, 'email_status', i.email_status) as before,
      jsonb_build_object('expires_at', now() + make_interval(days => greatest(7, round(extract(epoch from i.expires_at - i.created_at) / 86400)::int)), 'email_status', 'ส่งใหม่') as after
    from invitations i where i.workspace_id = ${ws}::uuid and i.status = 'pending' and i.email_status = 'failed' order by i.email_attempted_at nulls first`,
  apply: async ({ tx, workspaceId, appUrl }, t) => {
    const token = newToken();
    const [inv] = await sqlRows<{ email: string; expiresAt: string; message: string | null; projectId: string | null; invitedBy: string }>(tx, sql`
      update invitations i set token_hash = ${hashToken(token)}, created_at = now(),
        expires_at = now() + make_interval(days => greatest(7, round(extract(epoch from i.expires_at - i.created_at) / 86400)::int)),
        email_status = null, email_error = null, email_attempted_at = null
      where i.id = ${t.id} and i.workspace_id = ${workspaceId}::uuid and i.status = 'pending'
      returning i.email, i.expires_at as "expiresAt", i.message, i.project_id as "projectId", i.invited_by as "invitedBy"`);
    // มีคนตอบรับ / ยกเลิกไประหว่างทดลองกับรันจริง: ข้าม
    if (!inv) return;
    const [c] = await sqlRows<{ workspaceName: string; locale: string | null; inviterName: string | null; inviterEmail: string | null; projectName: string | null }>(tx, sql`
      select w.name as "workspaceName", w.default_locale as locale, u.display_name as "inviterName", u.email as "inviterEmail", p.name as "projectName"
      from workspaces w left join users u on u.id = ${inv.invitedBy}::uuid left join projects p on p.id = ${inv.projectId}::uuid and p.workspace_id = w.id
      where w.id = ${workspaceId}::uuid`);
    const mail = renderInvitationEmail({
      to: inv.email, inviteUrl: `${appUrl}/join/${token}`, expiresAt: new Date(inv.expiresAt), message: inv.message,
      workspaceName: c?.workspaceName ?? '', inviterName: c?.inviterName ?? '', projectName: c?.projectName ?? null, locale: c?.locale === 'en' ? 'en' : 'th',
    });
    return {
      mail: { to: inv.email, ...mail, replyTo: c?.inviterEmail ?? undefined },
      record: (status, error) => sql`update invitations set email_status = ${status}, email_error = ${error}, email_attempted_at = now() where id = ${t.id} and workspace_id = ${workspaceId}::uuid`,
    };
  },
};

export type MoveParams = { projectKey: string; targetKey: string; keys?: string; module?: string };
const moveIssues: MaintenanceScript<MoveParams> = {
  key: 'move_issues',
  table: 'issues',
  columns: ['project_id', 'number'],
  // เลขงานเปลี่ยนแล้ว ย้อนด้วยการคืนค่าไม่ได้ · ย้ายกลับด้วยสคริปต์เดียวกัน (ได้เลขใหม่อีกครั้ง Key เดิมยังพาไปถูก)
  undoable: false,
  remote: 'issue_move',
  params: z
    .object({ projectKey, targetKey: projectKey, keys: z.string().trim().max(4000).optional(), module: z.string().trim().max(120).optional() })
    .strict()
    .refine((p) => !!p.keys || !!p.module, 'ระบุ Key ของงาน หรือชื่อ Module อย่างใดอย่างหนึ่ง')
    .refine((p) => p.projectKey !== p.targetKey, 'โปรเจกต์ต้นทางและปลายทางต้องต่างกัน') as unknown as z.ZodType<MoveParams>,
  fields: [{ key: 'projectKey', kind: 'project' }, { key: 'targetKey', kind: 'project' }, { key: 'keys', kind: 'text', optional: true }, { key: 'module', kind: 'text', optional: true }],
  targets: () => sql`select null::uuid as id where false`,
};

export const SCRIPTS: MaintenanceScript[] = [staleSessions, staleInvites, shiftPlan, holidayShift, resendInvites, moveIssues] as unknown as MaintenanceScript[];
export const scriptOf = (key: string) => SCRIPTS.find((s) => s.key === key);
