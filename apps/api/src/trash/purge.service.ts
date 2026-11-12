import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Jobs } from '../queue/jobs.js';
import { DAY, removeStoredObjects } from './shared.js';

const s = schema;

/**
 * งานเบื้องหลัง `trash.purge` ทุกคืน 04:30 · ลบถาวรงาน โปรเจกต์ และไฟล์ที่พ้น trash_days ของแต่ละ Workspace + ไฟล์ในที่เก็บ
 * ใช้ SYSTEM_DB เพราะรวมทุก Workspace และไม่มีผู้ใช้ในบริบท (RLS ต้องมี app.workspace_id) · ทุกคำสั่งกรอง workspace_id เอง
 * Audit 1 แถวต่อ Workspace ที่มีของถูกลบ (ไม่ใช่ทุกแถว)
 */
@Injectable()
export class TrashPurgeService implements OnModuleInit {
  private readonly log = new Logger('TrashPurge');

  constructor(
    @Inject(SYSTEM_DB) private readonly sys: Db,
    private readonly jobs: Jobs,
    private readonly events: EventBus,
  ) {}

  async onModuleInit() {
    this.jobs.define('trash.purge', () => this.purge());
    await this.jobs.every('trash.purge', '30 4 * * *');
  }

  async purge(now = new Date()) {
    // Workspace ที่ลบแล้วรอ privacy.purge-workspaces ลบทั้งก้อน (ตาม purge_after) จึงข้าม
    const workspaces = await this.sys
      .select({ id: s.workspaces.id, days: s.workspaceSettings.trashDays })
      .from(s.workspaces)
      .leftJoin(s.workspaceSettings, eq(s.workspaceSettings.workspaceId, s.workspaces.id))
      .where(isNull(s.workspaces.deletedAt));
    const total = { workspaces: 0, issues: 0, projects: 0, files: 0 };
    for (const ws of workspaces) {
      try {
        const r = await this.purgeWorkspace(ws.id, ws.days ?? 30, now);
        if (r.issues + r.projects + r.files === 0) continue;
        total.workspaces++;
        total.issues += r.issues;
        total.projects += r.projects;
        total.files += r.files;
      } catch (err) {
        this.log.error(`ลบถาวรจากถังขยะของ ${ws.id} ไม่สำเร็จ: ${(err as Error).message}`);
      }
    }
    return total;
  }

  private async purgeWorkspace(workspaceId: string, days: number, now: Date) {
    const cutoff = new Date(now.getTime() - days * DAY);
    const { keys, counts } = await this.sys.transaction(async (tx) => {
      const projects = await tx.select({ id: s.projects.id, key: s.projects.key }).from(s.projects)
        .where(and(eq(s.projects.workspaceId, workspaceId), isNotNull(s.projects.deletedAt), lt(s.projects.deletedAt, cutoff)));
      const projectIds = projects.map((p) => p.id);
      // งานในโปรเจกต์ที่ลบทั้งโปรเจกต์ไปพร้อมโปรเจกต์ · Sub-task ที่ลบพร้อมแม่ไปตาม FK cascade (ลบไม่ช้ากว่าแม่จึงพ้นกำหนดแล้วเช่นกัน)
      const issues = await tx.select({ id: s.issues.id }).from(s.issues)
        .where(and(eq(s.issues.workspaceId, workspaceId), isNotNull(s.issues.deletedAt), lt(s.issues.deletedAt, cutoff), projectIds.length ? notInArray(s.issues.projectId, projectIds) : undefined));
      const files = await tx.select({ id: s.files.id }).from(s.files)
        .where(and(eq(s.files.workspaceId, workspaceId), isNotNull(s.files.deletedAt), lt(s.files.deletedAt, cutoff), projectIds.length ? notInArray(s.files.projectId, projectIds) : undefined));
      const fileIds = files.map((f) => f.id);
      const keys = [
        ...(fileIds.length ? await tx.select({ key: s.fileVersions.storageKey }).from(s.fileVersions).where(and(eq(s.fileVersions.workspaceId, workspaceId), inArray(s.fileVersions.fileId, fileIds))) : []),
        ...(projectIds.length ? await tx.select({ key: s.fileVersions.storageKey }).from(s.fileVersions).innerJoin(s.files, eq(s.files.id, s.fileVersions.fileId)).where(and(eq(s.files.workspaceId, workspaceId), inArray(s.files.projectId, projectIds))) : []),
      ].map((r) => r.key);
      if (issues.length) await tx.delete(s.issues).where(and(eq(s.issues.workspaceId, workspaceId), inArray(s.issues.id, issues.map((i) => i.id))));
      if (fileIds.length) await tx.delete(s.files).where(and(eq(s.files.workspaceId, workspaceId), inArray(s.files.id, fileIds)));
      if (projectIds.length) await tx.delete(s.projects).where(and(eq(s.projects.workspaceId, workspaceId), inArray(s.projects.id, projectIds)));
      const counts = { issues: issues.length, projects: projects.length, files: fileIds.length };
      if (counts.issues + counts.projects + counts.files > 0) {
        await tx.insert(s.auditLogs).values({ workspaceId, actorId: null, actorKind: 'system', category: 'data', action: 'trash.purged', targetType: 'workspace', targetId: workspaceId,
          summary: `ลบถาวรอัตโนมัติ (พ้นถังขยะ ${days} วัน): งาน ${counts.issues} · โปรเจกต์ ${counts.projects}${projects.length ? ` (${projects.map((p) => p.key).join(', ')})` : ''} · ไฟล์ ${counts.files}` });
      }
      return { keys, counts };
    });
    await removeStoredObjects(keys);
    if (counts.issues + counts.projects + counts.files > 0) {
      await this.events.publish({ type: 'trash.purged', workspaceId, actorId: null, data: { source: 'schedule', ...counts }, at: now });
    }
    return counts;
  }
}
