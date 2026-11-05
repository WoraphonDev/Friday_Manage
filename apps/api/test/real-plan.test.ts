// ตรวจตัวอ่านไฟล์กับแผนจริงในเครื่องผู้พัฒนาเท่านั้น (ไฟล์ Excel ไม่อยู่ใน repo)
//   REAL_PLAN_FILE="$HOME/Downloads/Development Plan 2026-11 (2026-11-05).xlsx" pnpm --filter @friday/api test real-plan
// ตัวเลขที่คาดหวังมาจากหน้า L3 และ docs/review-round-2.md
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';
import { WorkCalendar } from '../src/projects/calendar.js';
import { readPlanWorkbook } from '../src/imports/excel.js';
import { autoMap, checkPlan } from '../src/imports/plan.js';

const file = process.env.REAL_PLAN_FILE;

describe.skipIf(!file)('ไฟล์แผนจริง', () => {
  it('อ่านและตรวจได้ตรงกับหน้า L3', async () => {
    const wb = await readPlanWorkbook(await readFile(file!));
    const mapping = autoMap(wb.table.headers);
    const mapped = Object.values(mapping).filter(Boolean).length;
    const cal = new WorkCalendar(new Set([1, 2, 3, 4, 5]), new Set(wb.holidays.map((h) => h.date)));
    const r = checkPlan(wb, mapping, cal, new Set());
    console.log({ sheet: wb.table.name, mapped, holidays: wb.holidays.length, summary: r.summary });
    console.log(r.findings.filter((f) => f.no !== null).reduce<Record<string, number>>((m, f) => ((m[`${f.level} ${f.problem.replace(/[\d-]{6,}|\d+/g, '#')}`] = (m[`${f.level} ${f.problem.replace(/[\d-]{6,}|\d+/g, '#')}`] ?? 0) + 1), m), {}));
    expect(mapped).toBe(17);
    // หน้าจอ L3 ประมาณกลุ่มงานไว้ 60 · ไฟล์จริงมี 62 (นับแยกตาม Module)
    expect(r.summary).toMatchObject({ rows: 334, modules: 11, phases: 62, planFrom: '2026-11-05', planTo: '2027-04-21', ready: 310, backlog: 23, skipped: 1 });
    // ตรงกับ docs/review-round-2.md: Plan Start ตรงวันหยุด 11 งาน · ค่าในคอลัมน์ Sprint ผิด 9 แถว
    expect(r.findings.filter((f) => f.problem.includes('ตรงวันหยุด'))).toHaveLength(11);
    expect(r.findings.filter((f) => f.problem.includes('ดูไม่ใช่ชื่อกลุ่มงาน'))).toHaveLength(9);
    expect(r.summary.manDay).toBe(944);
  });
});

describe.skipIf(!file)('นำเข้าไฟล์แผนจริงผ่าน API (ฐานข้อมูลในเครื่อง)', () => {
  it('นำเข้า 333 งาน · ข้าม 1 แถวที่ไม่มี BA · 23 งานเข้า Backlog', async () => {
    const app = await createApp();
    await app.init();
    try {
      const agent = request.agent(app.getHttpServer());
      const { body } = await agent.get('/api/v1/auth/csrf');
      const h = { 'x-csrf-token': body.csrfToken };
      const tag = Date.now().toString(36);
      await agent.post('/api/v1/auth/signup').set(h).send({ email: `real-${tag}@example.com`, password: 'Friday2026', displayName: 'Mick', acceptTerms: true }).expect(201);
      await agent.post('/api/v1/workspaces').set(h).send({ name: 'Real plan check', slug: `real-${tag}` }).expect(201);
      const started = Date.now();
      const up = await agent.post(`/api/v1/w/real-${tag}/import-jobs`).set(h).field('mode', 'create').attach('file', await readFile(file!), 'Development Plan 2026-11 (2026-11-05).xlsx');
      expect(up.status).toBe(201);
      expect(up.body.project).toEqual({ name: 'Development Plan 2026-11', key: 'DP' });
      const done = await agent.post(`/api/v1/w/real-${tag}/import-jobs/${up.body.id}/commit`).set(h);
      console.log({ ms: Date.now() - started, result: done.body });
      expect(done.body).toMatchObject({ imported: 333, scheduled: 310, backlog: 23, skipped: 1, baseline: true });
      const issue = await agent.get(`/api/v1/w/real-${tag}/issues/DP-40`);
      // เลขงาน = ID: DP-39 คือ "ฟอร์มหลักประกัน 5 ประเภท" เหมือนใน Prototype
      expect((await agent.get(`/api/v1/w/real-${tag}/issues/DP-39`)).body.title).toMatch(/^ฟอร์มหลักประกัน 5 ประเภท/);
      // DP-40 เริ่ม 7 ธ.ค. ซึ่งเป็นวันหยุดชดเชย → นับจากวันทำงานถัดไป (docs/review-round-2.md)
      expect(issue.body.planStart).toBe('2026-12-08');
    } finally {
      await app.close();
    }
  });
});
