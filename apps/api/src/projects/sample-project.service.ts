import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { today } from '../common/dates.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { CreateIssueBody, IssuesService } from '../issues/issues.service.js';
import { addDays } from './calendar.js';
import { ProjectsService, type SampleProjectBody } from './projects.service.js';

/** ชื่อโปรเจกต์ตัวอย่าง · Onboarding checklist (A43) ใช้แยกโปรเจกต์ตัวอย่างออกจากการนับ */
export const SAMPLE_PROJECT_NAME = 'ร้านกาแฟออนไลน์ (ตัวอย่าง)';

/** ข้อมูลสมมติทั้งหมด (ร้านกาแฟออนไลน์) · ห้ามใช้ข้อมูลจริงของที่ทำงาน */
const MODULES = ['หน้าร้าน', 'ตะกร้าและชำระเงิน', 'หลังบ้านร้าน'];
const ISSUES: { module: number; title: string; size: 'XS' | 'S' | 'M' | 'L'; startIn: number; parent?: number; type?: 'Bug'; done?: boolean }[] = [
  { module: 0, title: 'หน้ารายการเมนูและค้นหา', size: 'M', startIn: 0, done: true },
  { module: 0, title: 'การ์ดเมนูพร้อมรูปและราคา', size: 'XS', startIn: 0, parent: 0, done: true },
  { module: 0, title: 'กรองเมนูตามหมวด', size: 'S', startIn: 1, parent: 0 },
  { module: 0, title: 'หน้ารายละเอียดเมนูและตัวเลือกเพิ่มเติม', size: 'S', startIn: 7 },
  { module: 1, title: 'ตะกร้าสินค้าและแก้จำนวน', size: 'M', startIn: 7 },
  { module: 1, title: 'ชำระเงินด้วย PromptPay QR', size: 'L', startIn: 14 },
  { module: 2, title: 'จัดการเมนูและราคา', size: 'M', startIn: 14 },
  { module: 2, title: 'รายงานยอดขายรายวัน', size: 'S', startIn: 21 },
  { module: 1, title: 'ราคารวมในตะกร้าไม่อัปเดตเมื่อลบสินค้า', size: 'XS', startIn: 10, type: 'Bug' },
];

/**
 * POST w/projects/sample · โปรเจกต์ตัวอย่างให้ทดลองใช้ (Onboarding / New Project)
 * แยกจาก ProjectsService เพราะต้องใช้ IssuesService ซึ่งพึ่ง ProjectsService อยู่แล้ว
 */
@Injectable()
export class SampleProjectService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly issues: IssuesService,
  ) {}

  async create(auth: AuthInfo, tenant: TenantInfo, input: z.infer<typeof SampleProjectBody>) {
    if (tenant.role === 'guest') throw forbidden('ws.project.create');
    const key = input.key ?? (await this.freeKey(tenant));
    const startDate = today();
    const goliveDate = addDays(startDate, 90);
    const project = await this.projects.create(auth, tenant, {
      name: SAMPLE_PROJECT_NAME,
      key,
      clientName: 'ลูกค้าสมมติ',
      description: 'โปรเจกต์ตัวอย่างสำหรับทดลองใช้งาน · ข้อมูลทั้งหมดเป็นข้อมูลสมมติ ลบทิ้งได้เมื่อไม่ใช้แล้ว',
      color: '#B45309',
      startDate,
      goliveDate,
      timezone: 'Asia/Bangkok',
      visibility: 'private',
      sprintLengthWeeks: 2,
      modules: MODULES,
      milestones: [{ name: 'เปิดร้านออนไลน์', date: goliveDate }],
    });

    // สร้างงานผ่าน IssuesService เพื่อให้ Plan End, เลขงาน, Activity และ Event ตรงกับงานที่ผู้ใช้สร้างเอง
    const detail = await this.projects.get(auth, tenant, key);
    const done = detail.statuses.find((x) => x.category === 'done' && !x.boardColumnId);
    const keys: string[] = [];
    for (const it of ISSUES) {
      const isBug = it.type === 'Bug';
      const created = await this.issues.create(
        auth,
        tenant,
        key,
        CreateIssueBody.parse({
          type: it.type ?? 'Task',
          title: it.title,
          moduleId: detail.modules[it.module].id,
          parentKey: it.parent === undefined ? undefined : keys[it.parent],
          size: it.size,
          planStart: addDays(startDate, it.startIn),
          assigneeIds: [auth.userId],
          statusId: it.done && !isBug ? done?.id : undefined,
          ...(isBug ? { severity: 'major', environment: 'sit', details: { steps: '1. ใส่เมนู 2 รายการลงตะกร้า\n2. ลบ 1 รายการ\n3. ราคารวมยังเป็นของ 2 รายการ' } } : {}),
        }),
      );
      keys.push(created.key as string);
    }
    return { ...project, sample: true, created: { ...project.created, issues: keys.length } };
  }

  /** DEMO, DEMO2 … ตัวแรกที่ยังว่าง */
  private async freeKey(tenant: TenantInfo) {
    for (let n = 1; n <= 99; n++) {
      const key = n === 1 ? 'DEMO' : `DEMO${n}`;
      if ((await this.projects.keyAvailable(tenant, key)).available) return key;
    }
    throw new AppError(409, 'key_taken', 'ตั้ง Key ของโปรเจกต์ตัวอย่างเองด้วย key', { fields: ['key'] });
  }
}
