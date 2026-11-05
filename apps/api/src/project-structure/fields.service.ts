import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { schema as s, type Tx } from '@friday/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { ProjectsService } from '../projects/projects.service.js';
import { audit, color, type Context, loadContext, name, nextSort, nonEmpty } from './context.js';

const fieldType = z.enum(['text', 'number', 'select', 'multi_select', 'user', 'date']);
const choice = z.object({ id: z.string().trim().min(1).max(64).optional(), label: z.string().trim().min(1).max(120), color: color.nullish() }).strict();
/** ตัวเลือกของฟิลด์ select / multi_select · id ของตัวเลือกคงที่เพื่อให้แก้ชื่อได้โดยค่าในงานไม่หาย */
const options = z.object({ choices: z.array(choice).min(1).max(200) }).strict();

const isSelect = (t: string) => t === 'select' || t === 'multi_select';
export const CreateCustomFieldBody = z.object({ name, fieldType, options: options.nullish() }).strict()
  .refine((v) => isSelect(v.fieldType) === !!v.options, { path: ['options'], message: 'ฟิลด์แบบตัวเลือกต้องมี options.choices · ฟิลด์แบบอื่นไม่ต้องส่ง' });
export const PatchCustomFieldBody = z.object({ name: name.optional(), fieldType: fieldType.optional(), options: options.nullish() }).strict()
  .refine((v) => Object.keys(v).length > 0, nonEmpty);
export const CreateLabelBody = z.object({ name: z.string().trim().min(1).max(60), color: color.nullish() }).strict();
export const PatchLabelBody = CreateLabelBody.partial().refine((v) => Object.keys(v).length > 0, nonEmpty);

type Field = typeof s.customFields.$inferSelect;
type Choice = { id: string; label: string; color?: string | null };
type Options = { choices: Choice[] } | null;

/** Custom field และ Label ของโปรเจกต์ (ฟิลด์มาตรฐานอยู่ในตาราง issues ไม่อยู่ในรายการนี้) */
@Injectable()
export class FieldsService {
  constructor(
    private readonly db: TenantDb,
    private readonly projects: ProjectsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Custom field
  // ---------------------------------------------------------------------------
  async listCustomFields(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.run(auth, tenant, key, 'read', async (tx, { project }) => ({ items: (await this.fields(tx, project.id)).map(fieldDto) }));
  }

  async createCustomField(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateCustomFieldBody>) {
    return this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      const current = await this.fields(tx, project.id);
      assertUniqueName(current, input.name, 'custom_field_exists', 'ฟิลด์');
      const [row] = await tx.insert(s.customFields).values({
        workspaceId: tenant.workspaceId, projectId: project.id, name: input.name, fieldType: input.fieldType,
        options: withIds(input.options ?? null), sort: nextSort(current),
      }).returning();
      await audit(tx, auth, tenant, project, 'project.custom_field_created', `เพิ่มฟิลด์ ${row.name}`);
      return fieldDto(row);
    });
  }

  async patchCustomField(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchCustomFieldBody>) {
    return this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      const current = await this.fields(tx, project.id);
      const field = current.find((f) => f.id === id);
      if (!field) throw notFound('ฟิลด์');
      if (input.name !== undefined) assertUniqueName(current.filter((f) => f.id !== id), input.name, 'custom_field_exists', 'ฟิลด์');
      const nextType = input.fieldType ?? field.fieldType;
      // เปลี่ยนชนิดฟิลด์ที่มีค่าในงานแล้วจะทำให้ค่าเดิมอ่านไม่ได้
      if (nextType !== field.fieldType && (await this.valueCount(tx, id))) {
        throw new AppError(409, 'custom_field_in_use', 'ฟิลด์นี้มีค่าในงานแล้ว เปลี่ยนชนิดไม่ได้');
      }
      let nextOptions = (field.options as Options) ?? null;
      if (input.options !== undefined) nextOptions = withIds(input.options ?? null);
      if (!isSelect(nextType)) nextOptions = null;
      if (isSelect(nextType) && !nextOptions?.choices.length) throw new AppError(400, 'invalid_input', 'ฟิลด์แบบตัวเลือกต้องมี options.choices');
      // ตัวเลือกที่ถูกเอาออกต้องไม่มีงานใช้อยู่
      const removed = ((field.options as Options)?.choices ?? []).filter((c) => !nextOptions?.choices.some((n) => n.id === c.id));
      if (isSelect(field.fieldType) && removed.length) {
        const used = [];
        for (const c of removed) if (await this.choiceUsed(tx, id, c.id)) used.push(c.label);
        if (used.length) throw new AppError(409, 'choice_in_use', `ตัวเลือก ${used.join(', ')} มีงานใช้อยู่`, { choices: used });
      }
      const [row] = await tx.update(s.customFields).set({ name: input.name ?? field.name, fieldType: nextType, options: nextOptions }).where(eq(s.customFields.id, id)).returning();
      return fieldDto(row);
    });
  }

  /** ลบฟิลด์พร้อมค่าในทุกงาน (FK cascade) */
  async deleteCustomField(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      const [row] = await tx.delete(s.customFields).where(and(eq(s.customFields.projectId, project.id), eq(s.customFields.id, id))).returning();
      if (!row) throw notFound('ฟิลด์');
      await audit(tx, auth, tenant, project, 'project.custom_field_deleted', `ลบฟิลด์ ${row.name}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Label
  // ---------------------------------------------------------------------------
  async listLabels(auth: AuthInfo, tenant: TenantInfo, key: string) {
    return this.run(auth, tenant, key, 'read', async (tx, { project }) => ({ items: await this.labelDtos(tx, project.id) }));
  }

  async createLabel(auth: AuthInfo, tenant: TenantInfo, key: string, input: z.infer<typeof CreateLabelBody>) {
    return this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      assertUniqueName(await this.labels(tx, project.id), input.name, 'label_exists', 'Label');
      const [row] = await tx.insert(s.labels).values({ workspaceId: tenant.workspaceId, projectId: project.id, name: input.name, color: input.color ?? null }).returning();
      return { ...labelDto(row), issueCount: 0 };
    });
  }

  async patchLabel(auth: AuthInfo, tenant: TenantInfo, key: string, id: string, input: z.infer<typeof PatchLabelBody>) {
    return this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      const labels = await this.labels(tx, project.id);
      if (!labels.some((l) => l.id === id)) throw notFound('Label');
      if (input.name !== undefined) assertUniqueName(labels.filter((l) => l.id !== id), input.name, 'label_exists', 'Label');
      await tx.update(s.labels).set(input).where(eq(s.labels.id, id));
      return (await this.labelDtos(tx, project.id)).find((l) => l.id === id)!;
    });
  }

  /** ลบ Label ออกจากทุกงานด้วย (FK cascade) */
  async deleteLabel(auth: AuthInfo, tenant: TenantInfo, key: string, id: string) {
    await this.run(auth, tenant, key, 'write', async (tx, { project }) => {
      const [row] = await tx.delete(s.labels).where(and(eq(s.labels.projectId, project.id), eq(s.labels.id, id))).returning();
      if (!row) throw notFound('Label');
      await audit(tx, auth, tenant, project, 'project.label_deleted', `ลบ Label ${row.name}`);
    });
  }

  // ---------------------------------------------------------------------------
  // ภายใน
  // ---------------------------------------------------------------------------
  private run<T>(auth: AuthInfo, tenant: TenantInfo, key: string, mode: 'read' | 'write', fn: (tx: Tx, ctx: Context) => Promise<T>) {
    return this.db.run(auth, tenant, async (tx) => fn(tx, await loadContext(tx, this.projects, auth, tenant, key, mode)));
  }

  private fields(tx: Tx, projectId: string) {
    return tx.select().from(s.customFields).where(eq(s.customFields.projectId, projectId)).orderBy(asc(s.customFields.sort), asc(s.customFields.name));
  }

  private labels(tx: Tx, projectId: string) {
    return tx.select().from(s.labels).where(eq(s.labels.projectId, projectId)).orderBy(asc(s.labels.name));
  }

  private async labelDtos(tx: Tx, projectId: string) {
    const rows = await this.labels(tx, projectId);
    const counts = await tx
      .select({ id: s.issueLabels.labelId, n: sql<number>`count(*)::int` })
      .from(s.issueLabels)
      .innerJoin(s.issues, eq(s.issues.id, s.issueLabels.issueId))
      .where(and(eq(s.issues.projectId, projectId), sql`${s.issues.deletedAt} is null`))
      .groupBy(s.issueLabels.labelId);
    const byId = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((l) => ({ ...labelDto(l), issueCount: byId.get(l.id) ?? 0 }));
  }

  private async valueCount(tx: Tx, fieldId: string) {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.issueCustomValues).where(eq(s.issueCustomValues.fieldId, fieldId));
    return row.n;
  }

  /** ค่า select เก็บเป็น id ของตัวเลือก · multi_select เก็บเป็น array ของ id */
  private async choiceUsed(tx: Tx, fieldId: string, choiceId: string) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(s.issueCustomValues)
      .where(and(eq(s.issueCustomValues.fieldId, fieldId), sql`(${s.issueCustomValues.value} = to_jsonb(${choiceId}::text) OR ${s.issueCustomValues.value} @> jsonb_build_array(${choiceId}::text))`));
    return row.n > 0;
  }
}

function withIds(o: { choices: { id?: string; label: string; color?: string | null }[] } | null): Options {
  if (!o) return null;
  const seen = new Set<string>();
  const choices = o.choices.map((c) => {
    const id = c.id ?? randomUUID();
    if (seen.has(id)) throw new AppError(400, 'invalid_input', 'id ของตัวเลือกซ้ำกัน', { id });
    seen.add(id);
    return { id, label: c.label, color: c.color ?? null };
  });
  return { choices };
}

function fieldDto(f: Field) {
  return { id: f.id, name: f.name, fieldType: f.fieldType, options: f.options as Options, sort: f.sort };
}

function labelDto(l: typeof s.labels.$inferSelect) {
  return { id: l.id, name: l.name, color: l.color };
}

function assertUniqueName(rows: { name: string }[], name: string, code: string, what: string) {
  if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new AppError(409, code, `มี${what}ชื่อ ${name} ในโปรเจกต์นี้แล้ว`);
}
