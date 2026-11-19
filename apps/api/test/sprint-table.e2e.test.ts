// Sprint ในแท็บ Table (ผู้ใช้ขอ 2026-11-19): สร้างหลาย Sprint, ตัวกรองหลายค่า, Export ตาม Sprint, นำเข้า Sprint จาก Excel · ข้อมูลสมมติเท่านั้น
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sprintSeries } from '../src/sprints/sprint-input.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let sequence = 0;
beforeAll(async () => { t = await startApp(); team = await seedTeam(t); });
afterAll(() => t.close());

async function download(c: Client, url: string) {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res as typeof res & { body: Buffer };
}
async function sheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Tasks')!;
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  const rows: Record<string, unknown>[] = [];
  ws.eachRow((row, n) => { if (n > 1) rows.push(Object.fromEntries(headers.map((h, i) => [h, row.getCell(i + 1).value]))); });
  return { wb, ws, headers, rows };
}

/** โปรเจกต์ 2 Module (A, B) · Sprint 1–3 · Task 4 งาน + Sub-task 1 งาน */
async function fixture() {
  const key = `ST${++sequence}`;
  const created = await team.lead.post(`${team.ws}/projects`, { key, name: `Sprint Table ${sequence}`, startDate: '2026-11-02', goliveDate: '2027-04-21', modules: ['Module A', 'Module B'], sprintLengthWeeks: 2 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const project = (await team.lead.get(`${team.ws}/projects/${key}`)).body as { id: string; modules: { id: string; name: string }[] };
  await t.owner.query('DELETE FROM sprints WHERE project_id=$1', [project.id]);
  const base = `${team.ws}/projects/${key}`;
  const series = await team.lead.post(`${base}/sprints/series`, { startDate: '2026-11-02', weeks: 2, count: 3 });
  expect(series.status, JSON.stringify(series.body)).toBe(201);
  const sprints = series.body.items as { id: string; name: string; number: number }[];
  const [a, b] = project.modules;
  const issue = async (input: Record<string, unknown>) => {
    const r = await team.lead.post(`${base}/issues`, { size: 'S', ...input });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { key: string; id: string };
  };
  // สร้าง B ก่อน A เพื่อดูว่าไฟล์ Export เรียงตาม Module ไม่ใช่เลขงาน
  const b1 = await issue({ title: 'งาน B ใน Sprint 2', moduleId: b.id, sprintId: sprints[1].id });
  const a1 = await issue({ title: 'งาน A ใน Sprint 2', moduleId: a.id, sprintId: sprints[1].id });
  const a2 = await issue({ title: 'งาน A ใน Sprint 3', moduleId: a.id, sprintId: sprints[2].id });
  const a3 = await issue({ title: 'งาน A ยังไม่เข้า Sprint', moduleId: a.id });
  const sub = await issue({ title: 'Sub-task ของงาน A', parentKey: a1.key });
  return { key, base, project, sprints, a, b, a1, a2, a3, b1, sub };
}
const keysOf = async (url: string) => {
  const r = await team.lead.get(url);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.items as { key: string }[]).map((x) => x.key).sort();
};

describe('สร้าง Sprint ต่อกัน (sprints/series)', () => {
  it('ช่วงวัน: ยาวตามจำนวนสัปดาห์ · วันจบถอยมาวันศุกร์ · Sprint ถัดไปเริ่มหลังครบสัปดาห์', () => {
    expect(sprintSeries('2026-11-02', 2, 3)).toEqual([
      { startDate: '2026-11-02', endDate: '2026-11-13' },
      { startDate: '2026-11-16', endDate: '2026-11-27' },
      { startDate: '2026-11-30', endDate: '2026-12-11' },
    ]);
    // เริ่มกลางสัปดาห์: จบก่อนวันเริ่มของ Sprint ถัดไป 1 วัน
    expect(sprintSeries('2026-11-04', 1, 2)).toEqual([{ startDate: '2026-11-04', endDate: '2026-11-10' }, { startDate: '2026-11-11', endDate: '2026-11-17' }]);
  });

  it('ตั้งชื่อ "Sprint <เลข>" ต่อจากเลขเดิม · GET sprints คืนทุก Sprint · ต้องมีสิทธิ์จัดการ Sprint', async () => {
    const f = await fixture();
    const more = await team.lead.post(`${f.base}/sprints/series`, { startDate: '2026-11-23', weeks: 3, count: 2 });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(more.body.items.map((s: { name: string; startDate: string; endDate: string }) => [s.name, s.startDate, s.endDate])).toEqual([
      ['Sprint 4', '2026-11-23', '2026-12-11'],
      ['Sprint 5', '2026-12-14', '2027-01-01'],
    ]);
    const list = await team.lead.get(`${f.base}/sprints`);
    expect(list.status).toBe(200);
    expect(list.body.sprintLengthWeeks).toBe(2);
    expect(list.body.items.map((s: { number: number }) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect((await team.lead.post(`${f.base}/sprints/series`, { startDate: '2026-11-23', weeks: 9, count: 2 })).status).toBe(400);
    expect((await team.lead.post(`${f.base}/sprints/series`, { startDate: '2026-11-23', weeks: 2, count: 27 })).status).toBe(400);
  });
});

describe('ตัวกรอง Module / Sprint หลายค่าในแท็บ Table', () => {
  it('module / sprint คั่นด้วย , · none · current · ค่าผิดรูปแบบ = 400', async () => {
    const f = await fixture();
    const list = `${f.base}/issues?view=table&limit=100`;
    expect(await keysOf(`${list}&sprint=${f.sprints[1].id}`)).toEqual([f.b1.key, f.a1.key, f.sub.key].sort());
    expect(await keysOf(`${list}&sprint=${f.sprints[2].id},none`)).toEqual([f.a2.key, f.a3.key].sort());
    expect(await keysOf(`${list}&module=${f.b.id}&sprint=${f.sprints[1].id},${f.sprints[2].id}`)).toEqual([f.b1.key]);
    expect(await keysOf(`${list}&module=${f.a.id},${f.b.id}&level=task&size=S&sprint=none`)).toEqual([f.a3.key]);
    // Sprint ปัจจุบัน: ยังไม่มี Sprint ที่เริ่ม = ว่าง · เริ่ม Sprint 2 แล้วเจองานของ Sprint 2
    expect(await keysOf(`${list}&sprint=current`)).toEqual([]);
    expect((await team.lead.post(`${f.base}/sprints/${f.sprints[1].id}/start`)).status).toBe(200);
    expect(await keysOf(`${list}&sprint=current,${f.sprints[2].id}`)).toEqual([f.b1.key, f.a1.key, f.sub.key, f.a2.key].sort());
    expect((await team.lead.get(`${list}&sprint=abc`)).status).toBe(400);
    expect((await team.lead.get(`${list}&module=current`)).status).toBe(400);
  });
});

describe('Export ตาม Sprint / ตัวกรอง', () => {
  it('ไฟล์มีเฉพาะงานของ Sprint เรียง Module → กลุ่ม → Task · มีคอลัมน์ Sprint · ชีตซ่อน Scope', async () => {
    const f = await fixture();
    const r = await download(team.lead, `${f.base}/export.xlsx?sprint=${f.sprints[1].id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain(`${f.key}-sprint-2-`);
    const { wb, headers, rows } = await sheet(r.body);
    expect(headers.indexOf('Sprint')).toBe(headers.indexOf('Group') + 1);
    // Module A ก่อน Module B แม้งาน B สร้างก่อน · Sub-task ต่อท้าย Task แม่
    expect(rows.map((x) => x.Key)).toEqual([f.a1.key, f.sub.key, f.b1.key]);
    expect(rows.map((x) => x.Sprint)).toEqual(['Sprint 2', 'Sprint 2', 'Sprint 2']);
    const scope = wb.getWorksheet('Scope')!;
    expect(scope.state).toBe('hidden');
    expect(scope.getCell('A2').value).toBe('Sprint 2');

    // ไฟล์ทั้งโปรเจกต์: ไม่มีชีต Scope · มีทุกงาน
    const all = await sheet((await download(team.lead, `${f.base}/export.xlsx`)).body);
    expect(all.wb.getWorksheet('Scope')).toBeUndefined();
    expect(all.rows).toHaveLength(5);

    // ตัวกรองแบบตาราง: Sub-task ที่ตรงพา Task แม่มาด้วย
    const filtered = await download(team.lead, `${f.base}/export.xlsx?module=${f.a.id}&level=subtask`);
    expect(filtered.headers['content-disposition']).toContain(`${f.key}-filtered-`);
    expect((await sheet(filtered.body)).rows.map((x) => x.Key)).toEqual([f.a1.key, f.sub.key]);
    expect((await team.lead.get(`${f.base}/export.xlsx?sprint=xyz`)).status).toBe(400);
  });

  it('นำเข้าไฟล์ Sprint กลับ: แทนที่แผนไม่ได้ · อัปเดตได้และย้าย Sprint ตามชื่อ (Sub-task ตามแม่) · ชื่อที่ไม่มี = เตือนและไม่แตะ', async () => {
    const f = await fixture();
    const file = (await download(team.lead, `${f.base}/export.xlsx?sprint=${f.sprints[1].id}`)).body;
    const replace = await team.lead.upload(`${team.ws}/import-jobs`, file, 'sprint-2.xlsx', { mode: 'update', projectKey: f.key, updateKind: 'replace' });
    expect(replace.status).toBe(422);
    expect(replace.body.error.code).toBe('partial_file_replace');

    const { wb, ws, headers } = await sheet(file);
    const col = headers.indexOf('Sprint') + 1;
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const key = row.getCell(1).value;
      if (key === f.a1.key) row.getCell(col).value = 'sprint 3'; // ไม่สนตัวพิมพ์
      if (key === f.b1.key) row.getCell(col).value = 'Sprint 99';
    });
    const edited = Buffer.from(await wb.xlsx.writeBuffer());
    const job = await team.lead.upload(`${team.ws}/import-jobs`, edited, 'sprint-2.xlsx', { mode: 'update', projectKey: f.key });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect(job.body.columns.find((c: { header: string }) => c.header === 'Sprint')?.field).toBe('sprint');
    expect((job.body.findings as { level: string; problem: string }[]).filter((x) => x.problem.includes('Sprint 99'))).toEqual([expect.objectContaining({ level: 'warn', problem: 'ไม่พบ Sprint "Sprint 99" ที่ยังเปิดอยู่ในโปรเจกต์' })]);
    // งานนอกไฟล์ไม่ถูกลบ (โหมดอัปเดตเก็บไว้เป็นค่าเริ่มต้น)
    const done = await team.lead.post(`${team.ws}/import-jobs/${job.body.id}/commit`);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const sprintOf = async (key: string) => (await team.lead.get(`${team.ws}/issues/${key}`)).body.sprintId;
    expect(await sprintOf(f.a1.key)).toBe(f.sprints[2].id);
    expect(await sprintOf(f.sub.key)).toBe(f.sprints[2].id);
    expect(await sprintOf(f.b1.key)).toBe(f.sprints[1].id);
    expect(await sprintOf(f.a3.key)).toBeNull();
    expect((await team.lead.get(`${team.ws}/issues/${f.a2.key}`)).status).toBe(200);
  });
});
