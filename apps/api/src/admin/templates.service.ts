import { Injectable } from '@nestjs/common';
import { schema } from '@friday/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { TemplateConfig } from '../projects/projects.service.js';
import { BUILTIN_TEMPLATE_IDS, builtinTemplate, mergeProfile, resolveProfile } from '../projects/field-profile.js';
import { assertAdmin, audit } from './shared.js';

const s = schema;

export const TemplateBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  /** รูปแบบเดียวกับที่ `POST w/projects` ใช้ (Workflow, ประเภทงาน, Custom field, Label …) */
  config: TemplateConfig.default({}),
});
export const CreateTemplateBody = TemplateBody.extend({
  /** เริ่มจาก Template ในตัว (คัดลอก config มา แล้วค่าใน config ที่ส่งมาทับ) */
  fromBuiltin: z.enum(BUILTIN_TEMPLATE_IDS).optional(),
});
export const PatchTemplateBody = TemplateBody.partial().strict();

/** ฟิลด์ที่ตั้งเป็นฟิลด์บังคับไม่ได้ (เช่น Actual, Progress) ตอบ 400 ตั้งแต่ตอนบันทึก Template */
function assertFields(config: z.infer<typeof TemplateConfig> | undefined) {
  if (config?.fields) mergeProfile(resolveProfile({}), { fields: config.fields }, []);
}

type Row = typeof s.projectTemplates.$inferSelect;
const dto = (r: Row) => ({ id: r.id, name: r.name, description: r.description, config: r.config, usageCount: r.usageCount, createdAt: r.createdAt, updatedAt: r.updatedAt });

/** Template โปรเจกต์มาตรฐานของ Workspace (N1) */
@Injectable()
export class TemplatesService {
  constructor(private readonly db: TenantDb) {}

  async list(auth: AuthInfo, tenant: TenantInfo) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => ({ items: (await tx.select().from(s.projectTemplates).orderBy(asc(s.projectTemplates.name))).map(dto) }));
  }

  async get(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => dto(await this.find(tx, id)));
  }

  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof CreateTemplateBody>) {
    assertAdmin(tenant);
    // เก็บ config ของ Template ในตัวตามที่เขียนไว้ (สถานะเป็นชื่อ) · ตรวจรูปแบบด้วย TemplateConfig ก่อน
    const base = input.fromBuiltin ? structuredClone(builtinTemplate(input.fromBuiltin)!.config) : {};
    TemplateConfig.parse(base);
    // ชุดฟิลด์รวมรายฟิลด์ (ส่งมาเฉพาะฟิลด์ที่ต่างจาก Template ในตัวได้)
    const baseFields = (base as { fields?: Record<string, object> }).fields;
    const config = { ...base, ...input.config, ...(baseFields && input.config.fields ? { fields: { ...baseFields, ...input.config.fields } } : {}) };
    assertFields(config);
    return this.db.run(auth, tenant, async (tx) => {
      await this.assertNameFree(tx, tenant, input.name);
      const [row] = await tx.insert(s.projectTemplates).values({ workspaceId: tenant.workspaceId, name: input.name, description: input.description ?? null, config }).returning();
      await audit(tx, auth, tenant, 'data', 'template.created', `สร้าง Template ${row.name}`, { type: 'project_template', id: row.id });
      return dto(row);
    });
  }

  async patch(auth: AuthInfo, tenant: TenantInfo, id: string, input: z.infer<typeof PatchTemplateBody>) {
    assertAdmin(tenant);
    assertFields(input.config);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      if (input.name && input.name.toLowerCase() !== cur.name.toLowerCase()) await this.assertNameFree(tx, tenant, input.name, cur.id);
      const [row] = await tx
        .update(s.projectTemplates)
        .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.config !== undefined ? { config: input.config } : {}), updatedAt: new Date() })
        .where(eq(s.projectTemplates.id, cur.id))
        .returning();
      await audit(tx, auth, tenant, 'data', 'template.updated', `แก้ Template ${row.name}: ${Object.keys(input).join(', ') || '-'}`, { type: 'project_template', id: row.id });
      return dto(row);
    });
  }

  /** ลบแล้วโปรเจกต์ที่สร้างไปแล้วไม่กระทบ (คัดลอกค่าตอนสร้าง) */
  async remove(auth: AuthInfo, tenant: TenantInfo, id: string) {
    assertAdmin(tenant);
    return this.db.run(auth, tenant, async (tx) => {
      const cur = await this.find(tx, id);
      await tx.delete(s.projectTemplates).where(eq(s.projectTemplates.id, cur.id));
      await audit(tx, auth, tenant, 'data', 'template.deleted', `ลบ Template ${cur.name} (ใช้ไป ${cur.usageCount} ครั้ง)`, { type: 'project_template', id: cur.id });
      return { id: cur.id, deleted: true };
    });
  }

  private async find(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], id: string) {
    if (!z.uuid().safeParse(id).success) throw notFound('Template');
    const [row] = await tx.select().from(s.projectTemplates).where(eq(s.projectTemplates.id, id));
    if (!row) throw notFound('Template');
    return row;
  }

  private async assertNameFree(tx: Parameters<Parameters<TenantDb['run']>[2]>[0], tenant: TenantInfo, name: string, exceptId?: string) {
    const [dup] = await tx
      .select({ id: s.projectTemplates.id })
      .from(s.projectTemplates)
      .where(and(eq(s.projectTemplates.workspaceId, tenant.workspaceId), sql`lower(${s.projectTemplates.name}) = lower(${name})`, exceptId ? ne(s.projectTemplates.id, exceptId) : undefined));
    if (dup) throw new AppError(409, 'template_name_taken', 'มี Template ชื่อนี้แล้ว');
  }
}
