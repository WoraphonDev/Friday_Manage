import { Injectable } from '@nestjs/common';
import { schema as s } from '@friday/db';
import { and, asc, desc, eq, exists, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { initials } from '../common/people.js';
import { AppError } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { projectAccess } from '../projects/permissions.js';
import { openStatus } from '../common/status-category.js';

export const SEARCH_TYPES = ['task', 'sub', 'bug', 'project', 'comment', 'file', 'person', 'diagram'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const SearchQuery = z.object({
  q: z.string().trim().min(1, 'พิมพ์คำค้นอย่างน้อย 1 ตัวอักษร').max(200),
  /** ชนิดเดียวหรือหลายชนิดคั่นด้วยจุลภาค (`type=task,bug`) */
  type: z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), z.array(z.enum(SEARCH_TYPES)).min(1).max(SEARCH_TYPES.length)).optional(),
  /** `me` = เฉพาะงานที่มอบหมายให้ฉัน (ชนิดอื่นไม่มีผู้รับผิดชอบจึงไม่แสดง) */
  assignee: z.literal('me').optional(),
  /** `open` = ตัดงานที่หมวดสถานะเป็น done (ชนิดอื่นไม่ถูกตัด) */
  status: z.literal('open').optional(),
  project: z.string().trim().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** รวมโปรเจกต์ที่ Archive (ค่าเริ่มต้นไม่รวม) */
  archived: z.stringbool().default(false),
  sort: z.enum(['relevance', 'updated', 'due']).default('relevance'),
});

const KEY_RE = /^#?([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})$/;
/** ตัด wildcard ของ LIKE ออกจากคำค้น เพื่อให้ % _ \ ในคำค้นเป็นตัวอักษรธรรมดา */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const SNIPPET = 48;

/** ตัดข้อความรอบจุดที่ตรงกับคำค้น (ฝั่งหน้าเว็บใช้ไฮไลต์ด้วย <mark>) */
export function snippet(text: string | null, q: string): string | null {
  if (!text) return null;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET);
  const to = Math.min(text.length, at + q.length + SNIPPET);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
}

interface Hit {
  type: SearchType;
  score: number;
  updatedAt: Date;
  due: string | null;
  data: Record<string, unknown>;
}

/** P1 · ค้นหา และ Command palette (Ctrl K) */
@Injectable()
export class SearchService {
  constructor(
    private readonly db: TenantDb,
    private readonly limits: PlanLimits,
  ) {}

  /** แพ็กเกจ Free ไม่มี Diagram: ไม่ค้น และไม่ส่งตัวกรองให้หน้าเว็บ (ไม่ตอบ 402 ในช่องค้นหา) */
  private async diagramsEnabled(workspaceId: string) {
    try {
      await this.limits.assertFeature(workspaceId, 'diagrams');
      return true;
    } catch {
      return false;
    }
  }

  async search(auth: AuthInfo, tenant: TenantInfo, q: z.infer<typeof SearchQuery>) {
    const diagrams = await this.diagramsEnabled(tenant.workspaceId);
    return this.db.run(auth, tenant, async (tx) => {
      const projects = await tx
        .select()
        .from(s.projects)
        .where(and(isNull(s.projects.deletedAt), q.archived ? undefined : and(isNull(s.projects.archivedAt), ne(s.projects.status, 'archived'))));
      // กรองตามสิทธิ์ก่อนตอบ: RLS ตัดโปรเจกต์ที่เข้าไม่ได้แล้ว ส่วน Guest ที่เป็น Viewer ต้องตัดงานที่ไม่ได้แชร์เพิ่ม
      const access = new Map<string, Awaited<ReturnType<typeof projectAccess>>>();
      for (const p of projects) access.set(p.id, await projectAccess(tx, auth, tenant, p));
      let scoped = projects.filter((p) => access.get(p.id)!.role);
      if (q.project) {
        const key = q.project.toUpperCase();
        scoped = scoped.filter((p) => p.key === key);
        if (!scoped.length) throw new AppError(404, 'project_not_found', 'ไม่พบโปรเจกต์');
      }
      const ids = scoped.map((p) => p.id);
      const byId = new Map(scoped.map((p) => [p.id, p]));
      const guestProjects = new Set(scoped.filter((p) => access.get(p.id)!.guestViewer).map((p) => p.id));
      const hits: Hit[] = [];
      const counts = Object.fromEntries(SEARCH_TYPES.map((t) => [t, 0])) as Record<SearchType, number>;
      const issueKinds: SearchType[] = ['task', 'sub', 'bug'];
      const want = (t: SearchType) => (!q.type || q.type.includes(t)) && (!q.assignee || issueKinds.includes(t));
      const pat = like(q.q);
      const lower = q.q.toLowerCase();

      const keyMatch = q.q.match(KEY_RE);
      const projectLabel = (id: string) => ({ key: byId.get(id)!.key, name: byId.get(id)!.name });

      // งาน / Sub-task / Bug -------------------------------------------------------------------
      if (ids.length && (want('task') || want('sub') || want('bug'))) {
        const textMatch = or(ilike(s.issues.title, pat), ilike(s.issues.description, pat));
        // Key เดิมของงานที่ย้ายข้ามโปรเจกต์ (DE-12 → WEB-46) ค้นเจองานใหม่เป็นผลตรงตัว
        const moved = keyMatch
          ? (await tx.select({ id: s.issueKeyAliases.issueId }).from(s.issueKeyAliases).innerJoin(s.projects, eq(s.projects.id, s.issueKeyAliases.projectId))
              .where(and(eq(s.projects.key, keyMatch[1]!.toUpperCase()), eq(s.issueKeyAliases.number, Number(keyMatch[2]))))).map((r) => r.id)
          : [];
        const exactKey = keyMatch ? and(eq(s.projects.key, keyMatch[1]!.toUpperCase()), eq(s.issues.number, Number(keyMatch[2]))) : undefined;
        const keyCond = moved.length ? or(exactKey, inArray(s.issues.id, moved)) : exactKey;
        const rows = await tx
          .select({ i: s.issues, type: s.issueTypes.name, status: s.workflowStatuses })
          .from(s.issues)
          .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
          .innerJoin(s.issueTypes, eq(s.issueTypes.id, s.issues.issueTypeId))
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
          .where(
            and(
              inArray(s.issues.projectId, ids),
              isNull(s.issues.deletedAt),
              keyCond ? or(keyCond, textMatch) : textMatch,
              q.status === 'open' ? openStatus() : undefined,
              q.assignee === 'me' ? exists(tx.select({ x: s.issueAssignees.userId }).from(s.issueAssignees).where(and(eq(s.issueAssignees.issueId, s.issues.id), eq(s.issueAssignees.userId, auth.userId)))) : undefined,
            ),
          )
          .orderBy(desc(s.issues.updatedAt))
          .limit(500);
        for (const { i, type, status } of rows) {
          const bug = type === 'Bug';
          if (guestProjects.has(i.projectId) && (!i.sharedWithGuests || bug)) continue;
          const kind: SearchType = bug ? 'bug' : i.parentId ? 'sub' : 'task';
          if (!want(kind)) continue;
          const key = `${byId.get(i.projectId)!.key}-${i.number}`;
          const exact = keyMatch && (key.toLowerCase() === `${keyMatch[1]}-${keyMatch[2]}`.toLowerCase() || moved.includes(i.id));
          const title = i.title.toLowerCase();
          const matchedIn = title.includes(lower) ? 'title' : 'description';
          counts[kind]++;
          hits.push({
            type: kind,
            score: exact ? 100 : title === lower ? 90 : title.startsWith(lower) ? 60 : matchedIn === 'title' ? 40 : 20,
            updatedAt: i.updatedAt,
            due: i.planEnd,
            data: { key, title: i.title, project: projectLabel(i.projectId), status: { name: status.name, category: status.category }, priority: i.priority, planEnd: i.planEnd, matchedIn, snippet: matchedIn === 'description' ? snippet(i.description, q.q) : null },
          });
        }
      }

      // โปรเจกต์ ------------------------------------------------------------------------
      if (want('project')) {
        for (const p of scoped) {
          const hay = `${p.name} ${p.key}`.toLowerCase();
          if (!hay.includes(lower)) continue;
          counts.project++;
          hits.push({ type: 'project', score: p.key.toLowerCase() === lower ? 80 : p.name.toLowerCase().startsWith(lower) ? 55 : 30, updatedAt: p.updatedAt, due: p.goliveDate, data: { key: p.key, name: p.name, color: p.color, archived: !!p.archivedAt, goliveDate: p.goliveDate } });
        }
      }

      // คอมเมนต์ / ไฟล์: Guest ที่เป็น Viewer ไม่เห็น -------------------------------------------
      const open = ids.filter((id) => !guestProjects.has(id));
      if (open.length && want('comment')) {
        const rows = await tx
          .select({ c: s.comments, i: s.issues })
          .from(s.comments)
          .innerJoin(s.issues, eq(s.issues.id, s.comments.issueId))
          .where(and(inArray(s.issues.projectId, open), isNull(s.issues.deletedAt), isNull(s.comments.deletedAt), ilike(s.comments.body, pat)))
          .orderBy(desc(s.comments.createdAt))
          .limit(200);
        for (const { c, i } of rows) {
          counts.comment++;
          hits.push({ type: 'comment', score: 15, updatedAt: c.createdAt, due: null, data: { issueKey: `${byId.get(i.projectId)!.key}-${i.number}`, issueTitle: i.title, project: projectLabel(i.projectId), commentId: c.id, snippet: snippet(c.body, q.q), createdAt: c.createdAt } });
        }
      }
      if (open.length && want('file')) {
        const rows = await tx
          .select()
          .from(s.files)
          .where(and(inArray(s.files.projectId, open), isNull(s.files.deletedAt), ilike(s.files.name, pat)))
          .orderBy(desc(s.files.createdAt))
          .limit(200);
        for (const f of rows) {
          counts.file++;
          hits.push({ type: 'file', score: f.name.toLowerCase().startsWith(lower) ? 35 : 15, updatedAt: f.createdAt, due: null, data: { id: f.id, name: f.name, kind: f.kind, mime: f.mime, project: projectLabel(f.projectId) } });
        }
      }

      // Diagram: ชื่อ, คำอธิบาย และข้อความในกล่อง / ชื่อ Lane / ป้ายบนเส้น (ผู้ใช้อนุมัติ 2026-11-19) · Guest ที่เป็น Viewer ไม่เห็นแท็บ Diagram
      if (diagrams && open.length && want('diagram')) {
        const inBoxes = sql`(exists (select 1 from jsonb_array_elements(${s.diagrams.content} -> 'nodes') n
          where n -> 'data' ->> 'label' ilike ${pat}
             or exists (select 1 from jsonb_array_elements_text(coalesce(n -> 'data' -> 'lanes', '[]'::jsonb)) l where l ilike ${pat}))
          or exists (select 1 from jsonb_array_elements(${s.diagrams.content} -> 'edges') e where e ->> 'label' ilike ${pat}))`;
        const rows = await tx
          .select({ d: s.diagrams, who: s.users.displayName })
          .from(s.diagrams)
          .leftJoin(s.users, eq(s.users.id, sql`coalesce(${s.diagrams.updatedBy}, ${s.diagrams.createdBy})`))
          .where(and(inArray(s.diagrams.projectId, open), isNull(s.diagrams.deletedAt), or(ilike(s.diagrams.name, pat), ilike(s.diagrams.description, pat), inBoxes)))
          .orderBy(desc(s.diagrams.updatedAt))
          .limit(200);
        for (const { d, who } of rows) {
          const name = d.name.toLowerCase();
          const inName = name.includes(lower);
          const inDescription = !inName && !!d.description?.toLowerCase().includes(lower);
          // ข้อความแรกในภาพที่ตรงคำค้น (แสดงว่า "พบในกล่อง …" และเปิดแล้วพาไปที่กล่องนั้น)
          const content = d.content as { nodes?: { data?: { label?: string; lanes?: string[] } }[]; edges?: { label?: string }[] };
          const texts = [...(content.nodes ?? []).flatMap((n) => [n.data?.label ?? '', ...(n.data?.lanes ?? [])]), ...(content.edges ?? []).map((e) => e.label ?? '')];
          const box = inName || inDescription ? null : (texts.find((x) => x.toLowerCase().includes(lower)) ?? null);
          counts.diagram++;
          hits.push({
            type: 'diagram',
            score: name === lower ? 85 : name.startsWith(lower) ? 58 : inName ? 38 : inDescription ? 18 : 16,
            updatedAt: d.updatedAt,
            due: null,
            data: { id: d.id, name: d.name, template: d.template, issueCount: d.issueIds.length, project: projectLabel(d.projectId), updatedAt: d.updatedAt, updatedBy: who, matchedIn: inName ? 'name' : inDescription ? 'description' : 'box', boxText: box },
          });
        }
      }

      // คน (`@ชื่อ`) · Guest ไม่เห็นรายชื่อคนในองค์กร ------------------------------------------------
      if (want('person') && tenant.role !== 'guest') {
        const name = q.q.startsWith('@') ? q.q.slice(1) : q.q;
        if (name) {
          const people = await tx
            .select({ id: s.users.id, displayName: s.users.displayName, email: s.users.email, avatarUrl: s.users.avatarUrl, jobTitle: s.workspaceMembers.jobTitle })
            .from(s.workspaceMembers)
            .innerJoin(s.users, eq(s.users.id, s.workspaceMembers.userId))
            .where(and(eq(s.workspaceMembers.workspaceId, tenant.workspaceId), eq(s.workspaceMembers.status, 'active'), ne(s.workspaceMembers.role, 'guest'), or(ilike(s.users.displayName, like(name)), ilike(s.users.email, like(name)))))
            .orderBy(asc(s.users.displayName))
            .limit(50);
          for (const p of people) {
            counts.person++;
            hits.push({ type: 'person', score: q.q.startsWith('@') ? 70 : p.displayName.toLowerCase().startsWith(name.toLowerCase()) ? 45 : 25, updatedAt: new Date(0), due: null, data: { id: p.id, displayName: p.displayName, initials: initials(p.displayName), avatarUrl: p.avatarUrl, email: p.email, jobTitle: p.jobTitle } });
          }
        }
      }

      const order: Record<string, (a: Hit, b: Hit) => number> = {
        relevance: (a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime(),
        updated: (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
        due: (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.score - a.score,
      };
      // เรียงตาม Due ใช้กับงาน / Bug ได้อย่างเดียว ชนิดอื่นไม่มี Due จึงไปท้ายตามความตรง
      hits.sort(order[q.sort]!);
      const total = Object.values(counts).reduce((n, c) => n + c, 0);
      return {
        q: q.q,
        total,
        counts,
        /** ชนิดที่ Workspace นี้ค้นได้ (Free ไม่มี diagram) · หน้าเว็บซ่อนตัวกรองที่ไม่มี */
        features: { diagrams },
        items: hits.slice(0, q.limit).map((h) => ({ type: h.type, ...h.data })),
      };
    });
  }
}

