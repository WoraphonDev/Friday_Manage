import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, heldScope, readRetention, schema } from '@friday/db';
import { sql } from 'drizzle-orm';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';

const s = schema;
const DAY = 86_400_000;
/** คีย์ใน ops_settings ที่หน้า PDPA ของ Friday Ops อ่านเป็น "ข้อมูลที่ลบตามนโยบายเมื่อคืน" */
export const RETENTION_LAST_RUN_KEY = 'retention_last_run';

const rowCount = (r: unknown) => (r as { rowCount?: number | null }).rowCount ?? 0;

/**
 * งาน `privacy.retention-logs` ทุกคืน 04:15 · ลบ Log ระบบ (IP, User agent) ที่เก่ากว่านโยบาย (ops_settings › retention.systemLogDays · O42 · H12)
 * - audit_logs: ล้างเฉพาะ ip / user_agent (ประวัติการกระทำยังอยู่ครบ เป็นหลักฐานของลูกค้า)
 * - user_sessions: ลบ session ที่จบไปแล้วก่อนวันตัด (ยังใช้งานอยู่ไม่แตะ)
 * ข้อมูลที่ติด Legal hold ข้าม · ใช้ SYSTEM_DB เพราะรวมทุก Workspace และไม่มีผู้ใช้ในบริบท
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly log = new Logger('Retention');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define('privacy.retention-logs', () => this.purgeLogs());
    await this.jobs.every('privacy.retention-logs', '15 4 * * *');
  }

  async purgeLogs(now = new Date()) {
    const { systemLogDays } = await readRetention(this.sys);
    const holds = await heldScope(this.sys);
    const cutoff = new Date(now.getTime() - systemLogDays * DAY);
    const heldWs = [...holds.anyHold];
    const wholeWs = [...holds.wholeWorkspace];
    const heldUsers = [...holds.users];
    const uuidArr = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

    const logs = await this.sys.execute(sql`
      update ${s.auditLogs} set ip = null, user_agent = null
      where created_at < ${cutoff} and (ip is not null or user_agent is not null)
        and not (workspace_id = any(${uuidArr(heldWs)}))`);
    // session ไม่ผูก Workspace: ข้ามผู้ใช้ที่ติด hold รายคน และสมาชิกที่ใช้งานอยู่ของ Workspace ที่ติด hold ทั้งก้อน
    const sessions = await this.sys.execute(sql`
      delete from ${s.userSessions} us
      where (us.revoked_at < ${cutoff} or (us.last_seen_at < ${cutoff} and (us.remember_until is null or us.remember_until < ${now})))
        and not (us.user_id = any(${uuidArr(heldUsers)}))
        and not exists (select 1 from ${s.workspaceMembers} m where m.user_id = us.user_id and m.status = 'active' and m.workspace_id = any(${uuidArr(wholeWs)}))`);
    const result = { logRows: rowCount(logs), sessionRows: rowCount(sessions), systemLogDays };
    await this.sys
      .insert(s.opsSettings)
      .values({ key: RETENTION_LAST_RUN_KEY, value: { at: now.toISOString(), ...result } })
      .onConflictDoUpdate({ target: s.opsSettings.key, set: { value: { at: now.toISOString(), ...result } } });
    if (result.logRows + result.sessionRows > 0) this.log.log(`ลบ Log ระบบเก่ากว่า ${systemLogDays} วัน: audit ${result.logRows} แถว · session ${result.sessionRows} แถว`);
    return result;
  }
}
