// A15 · Import Excel โหมดอัปเดตแผน และ Export · ข้อมูลสมมติเท่านั้น
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events.js';
import { type Client, seedTeam, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;
let wsId: string;
const events: { type: string; data: Record<string, unknown> }[] = [];

const HEADERS = ['ID', 'No.', 'Module', 'Sprint', 'Module Task', 'Screen ID', 'FR / NFR', 'BA', 'Status', 'Dev', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'Remark'];
const d = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

async function sourceWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Table');
  ws.addRow(HEADERS);
  const rows: (string | number | Date | null)[][] = [
    [1, 1, 'Credit Line', 'S1', 'Login', 'SCR-001', 'FR-001', 'Mick', 'Not Start', 'Kaijeaw', null, 3, d('2026-11-09'), d('2026-11-11'), null, null, null],
    [2, 2, 'Drawdown', 'S1', 'Approve', null, null, 'Mick', 'In Progress', 'Kaijeaw', null, 2, d('2026-11-12'), d('2026-11-13'), d('2026-11-12'), null, 'ด่วน'],
    [3, 3, 'Drawdown', 'S2', 'Report', null, 'FR-002', 'Mick', 'Not Start', 'Kaijeaw', null, 5, d('2026-11-16'), d('2026-11-20'), null, null, null],
    [4, 4, 'Credit Line', 'S2', 'Backlog item', null, null, null, 'Not Start', null, null, null, null, null, null, null, null],
  ];
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ไฟล์ส่งออกรูปแบบใหม่ (ชีต Tasks) · อ้างคอลัมน์ด้วยชื่อผ่าน col() เพื่อไม่ผูกกับลำดับ
const TASK_HEADERS = ['Key', 'Parent Key', 'Module', 'Group', 'Title', 'Status', 'Priority', 'Business Analyst', 'System Analyst', 'Developer', 'QA / Reviewer', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'Requirement', 'Screen', 'Label', 'Description', 'Remark'];
const col = (name: string) => TASK_HEADERS.indexOf(name) + 1;
async function edit(buf: Buffer, fn: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  fn(wb.getWorksheet('Tasks')!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function download(c: Client, url: string) {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res as typeof res & { body: Buffer };
}
const exportOf = async (key: string) => {
  const r = await download(team.lead, `${team.ws}/projects/${key}/export.xlsx`);
  expect(r.status).toBe(200);
  return r.body;
};

async function updateJob(key: string, file: Buffer, c: Client = team.lead) {
  const r = await c.upload(`${team.ws}/import-jobs`, file, `${key}-plan.xlsx`, { mode: 'update', projectKey: key });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
const commit = async (id: string) => {
  const r = await team.lead.post(`${team.ws}/import-jobs/${id}/commit`);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const planChanges = async (key: string) =>
  (await t.owner.query(`SELECT pc.field, pc.old_value, pc.new_value, pc.reason, pc.source, pc.baseline_id, i.number FROM plan_changes pc JOIN issues i ON i.id = pc.issue_id JOIN projects p ON p.id = pc.project_id WHERE p.key = $1 ORDER BY pc.changed_at, pc.field`, [key])).rows;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
  wsId = (await t.owner.query('SELECT id FROM workspaces WHERE slug = $1', [team.slug])).rows[0].id;
  t.app.get(EventBus).on('import.completed', (e) => void events.push({ type: e.type, data: e.data }));
});
afterAll(() => t.close());

describe('สร้างโปรเจกต์จากไฟล์แล้ว Export', () => {
  it('นำเข้าแบบ create → โปรเจกต์ IMP พร้อม Baseline v1', async () => {
    const up = await team.lead.upload(`${team.ws}/import-jobs`, await sourceWorkbook(), 'Imp Plan.xlsx', { mode: 'create' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect((await team.lead.patch(`${team.ws}/import-jobs/${up.body.id}`, { project: { key: 'IMP', name: 'Imp Plan' } })).status).toBe(200);
    const done = await commit(up.body.id);
    expect(done).toMatchObject({ mode: 'create', imported: 4, project: { key: 'IMP' } });
    expect(events.at(-1)).toMatchObject({ type: 'import.completed', data: { mode: 'create', projectKey: 'IMP', imported: 4 } });
  });

  it('GET p/export.xlsx: ชีต Tasks 20 คอลัมน์ + คำแนะนำ + ค่าที่ใช้ได้ + Holidays · Guest/คนนอกไม่ได้', async () => {
    const res = await download(team.lead, `${team.ws}/projects/IMP/export.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/IMP-plan-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const table = wb.getWorksheet('Tasks')!;
    const header = (table.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(TASK_HEADERS);
    expect(table.rowCount).toBe(5);
    const row = table.getRow(3).values as unknown[];
    expect(Array.from({ length: 14 }, (_, i) => row[i + 1] ?? null)).toEqual(['IMP-2', null, 'Drawdown', null, 'Approve', 'In progress', 'Medium', 'Mick', null, 'Kaijeaw', null, 'S', 2, d('2026-11-12')]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Tasks', 'Timeline', 'ค่าที่ใช้ได้', 'คำแนะนำ', 'Holidays']);
    // Timeline: หัวคอลัมน์ข้อมูล + ช่องวัน · แถว Module แล้วงานในนั้น · ช่องในช่วง Plan ถูกระบายสี
    const tl = wb.getWorksheet('Timeline')!;
    expect((tl.getRow(3).values as unknown[]).slice(1, 7)).toEqual(['Key', 'Task', 'Status', 'Plan Start', 'Plan End', '%']);
    const names = Array.from({ length: tl.rowCount }, (_, i) => tl.getRow(i + 1).getCell(2).value);
    expect(names).toEqual(expect.arrayContaining(['Credit Line', 'Login', 'Drawdown', 'Approve']));
    const approve = tl.getRow(names.indexOf('Approve') + 1);
    const days = tl.columnCount - 6;
    const filled = Array.from({ length: days }, (_, i) => approve.getCell(7 + i).fill as { fgColor?: { argb?: string } } | undefined).filter((f) => f?.fgColor?.argb && f.fgColor.argb !== 'FFF3F4F6');
    expect(filled.length).toBe(2); // Plan 12–13 พ.ย. = 2 ช่อง (ช่องละวัน)
    const weekly = await download(team.lead, `${team.ws}/projects/IMP/export.xlsx?timeline=week`);
    const wbw = new ExcelJS.Workbook();
    await wbw.xlsx.load(weekly.body as unknown as ArrayBuffer);
    expect(String(wbw.getWorksheet('Timeline')!.getCell(1, 1).value)).toContain('ช่องละสัปดาห์');
    const values = wb.getWorksheet('ค่าที่ใช้ได้')!;
    expect((values.getRow(1).values as unknown[]).slice(1)).toEqual(['Status', 'Priority', 'Size', 'Module', 'สมาชิก']);
    expect(values.getColumn(1).values.slice(2)).toEqual(['To do', 'In progress', 'Review', 'Done']);
    expect(wb.getWorksheet('Holidays')!.rowCount).toBeGreaterThan(1);
    expect((await team.dev.get(`${team.ws}/projects/IMP/export.xlsx`)).status).toBe(404); // dev ไม่ได้เป็นสมาชิกโปรเจกต์ IMP
    expect((await team.lead.get(`${team.ws}/projects/NOPE/export.xlsx`)).status).toBe(404);
  });
});

describe('อัปเดตแผนจากไฟล์', () => {
  it('Export แล้ว Import อัปเดตด้วยไฟล์เดิม = ไม่มีอะไรเปลี่ยน', async () => {
    const job = await updateJob('IMP', await exportOf('IMP'));
    expect(job.mode).toBe('update');
    expect(job.diff).toEqual({ added: [], changed: [], missing: [], unchanged: 4 });
    expect(job.summary).toMatchObject({ rows: 4, skipped: 0 });
    expect(job.findings.filter((f: { level: string }) => f.level === 'err')).toEqual([]);
    const before = (await t.owner.query(`SELECT count(*)::int AS n FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.key = 'IMP'`)).rows[0].n;
    const done = await commit(job.id);
    expect(done).toMatchObject({ mode: 'update', added: 0, changed: 0, unchanged: 4, deleted: 0, kept: 0, planChanges: 0 });
    expect(await planChanges('IMP')).toEqual([]);
    expect((await t.owner.query(`SELECT count(*)::int AS n FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.key = 'IMP'`)).rows[0].n).toBe(before);
    expect(events.at(-1)).toMatchObject({ data: { mode: 'update', projectKey: 'IMP', changed: 0 } });
  });

  it('แก้ Man-Day 1 แถว → ผลตรวจรายฟิลด์ → plan_change 1 รายการ (source import)', async () => {
    const file = await edit(await exportOf('IMP'), (ws) => (ws.getRow(3).getCell(col('Man-Day')).value = 3));
    const job = await updateJob('IMP', file);
    expect(job.diff.changed).toEqual([{ no: 3, key: 'IMP-2', title: 'Approve', fields: [{ field: 'estimateMd', label: 'Man-Day', old: 2, new: 3 }] }]);
    expect(job.diff.unchanged).toBe(3);
    expect(job.findings.some((f: { problem: string }) => f.problem.startsWith('Plan End ในไฟล์'))).toBe(true); // เตือนแต่ใช้ค่าในไฟล์
    const before = (await team.lead.get(`${team.ws}/issues/IMP-2`)).body;
    const done = await commit(job.id);
    expect(done).toMatchObject({ changed: 1, planChanges: 1, unchanged: 3 });

    const pcs = await planChanges('IMP');
    expect(pcs).toHaveLength(1);
    expect(pcs[0]).toMatchObject({ field: 'estimateMd', source: 'import', number: 2 });
    expect(Number(pcs[0].old_value)).toBe(2);
    expect(Number(pcs[0].new_value)).toBe(3);
    expect(pcs[0].baseline_id).not.toBeNull();
    expect(pcs[0].reason).toContain('IMP-plan.xlsx');
    const after = (await team.lead.get(`${team.ws}/issues/IMP-2`)).body;
    expect(after).toMatchObject({ estimateMd: 3, planEnd: before.planEnd });
    expect(after.version).toBeGreaterThan(before.version);
    expect(events.at(-1)).toMatchObject({ data: { changed: 1, planChanges: 1 } });

    // หน้าแผนเห็นรายการนี้ใน "การแก้ไขแผน"
    const list = await team.lead.get(`${team.ws}/projects/IMP/plan-changes`);
    expect(list.body.items.find((x: { source: string }) => x.source === 'import')).toMatchObject({ fieldLabel: 'Man-Day' });
  });

  it('เหตุผลที่ระบุเอง · เปลี่ยนชื่อ/สถานะ/Dev/วัน แล้วแจกแจงทีละฟิลด์', async () => {
    const file = await edit(await exportOf('IMP'), (ws) => {
      ws.getRow(2).getCell(col('Title')).value = 'Login (แก้ชื่อ)'; // title: ไม่ใช่ฟิลด์แผน
      ws.getRow(2).getCell(col('Status')).value = 'Done';
      ws.getRow(4).getCell(col('Developer')).value = 'Mick'; // Dev Kaijeaw → Mick
      ws.getRow(4).getCell(col('Plan Start')).value = d('2026-11-17');
      ws.getRow(4).getCell(col('Plan End')).value = d('2026-11-23');
    });
    const job = await updateJob('IMP', file);
    // no = แถวใน Excel (ไฟล์รูปแบบใหม่ไม่มีคอลัมน์ No.)
    expect(job.diff.changed.map((c: { key: string; fields: { field: string }[] }) => [c.key, c.fields.map((f) => f.field)])).toEqual([
      ['IMP-1', ['title', 'status']],
      ['IMP-3', ['planStart', 'planEnd', 'devs']],
    ]);
    const patched = await team.lead.patch(`${team.ws}/import-jobs/${job.id}`, { planChangeReason: 'ลูกค้าขอเลื่อน Report' });
    expect(patched.status).toBe(200);
    expect(patched.body.planChangeReason).toBe('ลูกค้าขอเลื่อน Report');
    const done = await commit(job.id);
    expect(done).toMatchObject({ changed: 2, planChanges: 3 }); // แถว 3: planStart, planEnd, assigneeIds · ชื่อ/สถานะไม่ใช่ฟิลด์แผน
    const pcs = (await planChanges('IMP')).filter((x) => x.reason === 'ลูกค้าขอเลื่อน Report');
    expect(pcs.map((x) => x.field).sort()).toEqual(['assigneeIds', 'planEnd', 'planStart']);
    const dev = pcs.find((x) => x.field === 'assigneeIds')!;
    expect(dev.old_value).toEqual([team.devId]);
    expect(dev.new_value).toEqual([team.leadId]);

    const one = (await team.lead.get(`${team.ws}/issues/IMP-1`)).body;
    expect(one).toMatchObject({ title: 'Login (แก้ชื่อ)', status: { name: 'Done' } });
    const three = (await team.lead.get(`${team.ws}/issues/IMP-3`)).body;
    expect(three).toMatchObject({ planStart: '2026-11-17', planEnd: '2026-11-23', assigneeIds: [team.leadId] });
    const act = await t.owner.query(`SELECT field, actor_kind FROM activities a JOIN issues i ON i.id = a.issue_id WHERE i.number = 3 AND a.verb = 'updated' AND a.actor_kind = 'import'`);
    expect(act.rows.map((x: { field: string }) => x.field).sort()).toEqual(['assigneeIds', 'devs', 'planEnd', 'planStart'].filter((f) => f !== 'devs'));
  });

  it('งานใหม่ในไฟล์ถูกเพิ่ม · งานที่หายไปไม่ถูกลบเอง ให้เลือก keep / delete', async () => {
    const file = await edit(await exportOf('IMP'), (ws) => {
      ws.addRow(['IMP-9', null, 'Drawdown', null, 'งานใหม่จากไฟล์', 'Not Start', null, 'Mick', null, 'Kaijeaw', null, null, 2, d('2026-11-24'), d('2026-11-25'), null, null, 'FR-009', 'SCR-009', null, null]);
      ws.spliceRows(5, 1); // ลบแถว IMP-4 (Backlog item) ออกจากไฟล์
    });
    const job = await updateJob('IMP', file);
    expect(job.diff.added).toEqual([{ no: 5, number: 9, title: 'งานใหม่จากไฟล์', module: 'Drawdown' }]);
    expect(job.diff.missing).toEqual([{ no: 4, key: 'IMP-4', title: 'Backlog item', status: 'To do' }]);

    // ค่าเริ่มต้น keep: ไม่ลบ
    const keepJob = await updateJob('IMP', file);
    const kept = await commit(keepJob.id);
    expect(kept).toMatchObject({ added: 1, deleted: 0, kept: 1 });
    expect((await team.lead.get(`${team.ws}/issues/IMP-4`)).status).toBe(200);
    const created = (await team.lead.get(`${team.ws}/issues/IMP-9`)).body;
    expect(created).toMatchObject({ title: 'งานใหม่จากไฟล์', planStart: '2026-11-24', planEnd: '2026-11-25', assigneeIds: [team.devId] });
    // ไฟล์รูปแบบใหม่จับคู่ด้วย Key จึงไม่บันทึก No.
    expect((await t.owner.query(`SELECT excel_row_no FROM issues WHERE id = $1`, [created.id])).rows[0].excel_row_no).toBeNull();
    expect((await team.lead.post(`${team.ws}/projects/IMP/issues`, { title: 'ถัดไป', moduleId: created.moduleId })).body.key).toBe('IMP-10');

    // ไฟล์ถัดไปที่ยังไม่มีแถว IMP-4 → เลือกลบ (no ของงานที่หายไป = เลขงาน)
    const again = await updateJob('IMP', await edit(await exportOf('IMP'), (ws) => ws.spliceRows(5, 1)));
    expect(again.diff.missing.map((m: { no: number }) => m.no)).toEqual([4]);
    const set = await team.lead.patch(`${team.ws}/import-jobs/${again.id}`, { missing: { '4': 'delete' } });
    expect(set.body.missingChoice).toEqual({ '4': 'delete' });
    const gone = await commit(again.id);
    expect(gone).toMatchObject({ deleted: 1, kept: 0 });
    expect((await t.owner.query(`SELECT i.deleted_at FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = 'IMP' AND i.number = 4`)).rows[0].deleted_at).not.toBeNull();
    expect((await team.lead.post(`${team.ws}/import-jobs/${again.id}/commit`)).body.error.code).toBe('import_not_editable');
  });

  it('แถวที่ต้องแก้ถูกข้าม ไม่นับเป็นงานที่หายไป · missingAll ใช้กับทุกงาน', async () => {
    const file = await edit(await exportOf('IMP'), (ws) => {
      ws.getRow(2).getCell(col('Man-Day')).value = 'abc'; // Man-Day ผิดรูปแบบ → ข้ามแถว
    });
    const job = await updateJob('IMP', file);
    expect(job.summary.skipped).toBe(1);
    expect(job.diff.missing).toEqual([]);
    expect(job.findings.some((f: { level: string; problem: string }) => f.level === 'err' && f.problem.includes('Man-Day'))).toBe(true);
    const r = await team.lead.patch(`${team.ws}/import-jobs/${job.id}`, { missingAll: 'delete', planChangeReason: 'x' });
    expect(r.body.missingAll).toBe('delete');
    const done = await commit(job.id);
    expect(done).toMatchObject({ changed: 0, deleted: 0, skipped: 1 });
  });
});

describe('สิทธิ์และข้อมูลขาเข้า', () => {
  it('ต้องมี project.baseline · mode / projectKey ผิด → 400/404', async () => {
    const f = await exportOf('IMP');
    const asDev = await team.dev.upload(`${team.ws}/import-jobs`, f, 'x.xlsx', { mode: 'update', projectKey: 'DP' });
    expect(asDev.status).toBe(403);
    expect((await team.lead.upload(`${team.ws}/import-jobs`, f, 'x.xlsx', { mode: 'update' })).body.error.code).toBe('project_required');
    expect((await team.lead.upload(`${team.ws}/import-jobs`, f, 'x.xlsx', { mode: 'update', projectKey: 'ZZZ' })).status).toBe(404);
    expect((await team.lead.upload(`${team.ws}/import-jobs`, f, 'x.xlsx', { mode: 'merge' })).body.error.code).toBe('mode_not_supported');
    // งานนำเข้าเป็นของผู้อัปโหลดเท่านั้น
    const job = await updateJob('IMP', f);
    expect((await team.dev.get(`${team.ws}/import-jobs/${job.id}`)).status).toBe(404);
    // สิทธิ์ถูกถอดระหว่างทาง → commit ไม่ได้ (Owner ของ Workspace ผ่านเสมอ จึงใช้ dev ที่ถูกลดเป็น member)
    await t.owner.query(`INSERT INTO project_members (workspace_id, project_id, user_id, role) SELECT workspace_id, id, $1, 'admin' FROM projects WHERE key = 'IMP'`, [team.devId]);
    const devJob = await updateJob('IMP', f, team.dev);
    await t.owner.query(`UPDATE project_members SET role = 'member' WHERE user_id = $1 AND project_id = (SELECT id FROM projects WHERE key = 'IMP')`, [team.devId]);
    expect((await team.dev.post(`${team.ws}/import-jobs/${devJob.id}/commit`)).status).toBe(403);
    expect((await commit(job.id)).mode).toBe('update');
  });
});

describe('งานที่สร้างในระบบ (ไม่มี No.) จับคู่ด้วย Key / ID', () => {
  it('Export → Import อัปเดต = ไม่เพิ่มงานซ้ำ', async () => {
    const proj = await team.lead.post(`${team.ws}/projects`, { name: 'In App', key: 'APP', startDate: '2026-11-05', goliveDate: '2027-04-21', modules: ['Core'] });
    expect(proj.status).toBe(201);
    const moduleId = (await team.lead.get(`${team.ws}/projects/APP`)).body.modules[0].id;
    for (const [title, start, md] of [['A', '2026-11-09', 2], ['B', '2026-11-11', 3]] as const) {
      const r = await team.lead.post(`${team.ws}/projects/APP/issues`, { title, moduleId, planStart: start, estimateMd: md, assigneeIds: [team.devId] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    expect((await team.lead.post(`${team.ws}/projects/APP/baselines`, {})).status).toBe(201);
    const file = await exportOf('APP');
    const job = await updateJob('APP', file);
    expect(job.diff).toEqual({ added: [], changed: [], missing: [], unchanged: 2 });
    const done = await commit(job.id);
    expect(done).toMatchObject({ added: 0, changed: 0, unchanged: 2 });
    // จับคู่ด้วย Key จึงไม่ต้องบันทึก No.
    const nos = (await t.owner.query(`SELECT number, excel_row_no FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = 'APP' ORDER BY number`)).rows;
    expect(nos).toEqual([{ number: 1, excel_row_no: null }, { number: 2, excel_row_no: null }]);
    expect(wsId).toBeTruthy();
  });

  it('ไฟล์รูปแบบเดิม (ID + No.) ยังจับคู่ด้วย ID แล้วบันทึก No. ให้ครั้งต่อไป', async () => {
    // แปลงไฟล์ Export เป็นคอลัมน์แบบไฟล์แผนเดิม
    const src = new ExcelJS.Workbook();
    await src.xlsx.load((await exportOf('APP')) as unknown as ArrayBuffer);
    const legacy = new ExcelJS.Workbook();
    const ws = legacy.addWorksheet('Table');
    ws.addRow(['ID', 'No.', 'Module', 'Module Task', 'BA', 'Status', 'Dev', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Remark']);
    src.getWorksheet('Tasks')!.eachRow((r, i) => {
      if (i === 1) return;
      const v = (c: number) => r.getCell(c).value ?? null;
      ws.addRow([Number(String(v(col('Key'))).split('-')[1]), i - 1, ...['Module', 'Title', 'Business Analyst', 'Status', 'Developer', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Remark'].map((h) => v(col(h)))]);
    });
    const file = Buffer.from(await legacy.xlsx.writeBuffer());
    const job = await updateJob('APP', file);
    expect(job.diff).toEqual({ added: [], changed: [], missing: [], unchanged: 2 });
    await commit(job.id);
    const nos = (await t.owner.query(`SELECT number, excel_row_no FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = 'APP' ORDER BY number`)).rows;
    expect(nos).toEqual([{ number: 1, excel_row_no: 1 }, { number: 2, excel_row_no: 2 }]);
    const next = await updateJob('APP', file);
    expect(next.diff.unchanged).toBe(2);
  });
});

describe('ไฟล์รูปแบบใหม่: Template, Sub-task และผู้รับผิดชอบ', () => {
  const row = (v: Partial<Record<(typeof TASK_HEADERS)[number], string | number | Date | null>>) => TASK_HEADERS.map((h) => v[h as keyof typeof v] ?? null);
  const issueRow = async (key: string, number: number) =>
    (
      await t.owner.query(
        `SELECT i.title, i.priority, i.excel_row_no, par.number AS parent, m.name AS module, i.sa_id, i.reviewer_id, i.ba_id,
                (SELECT array_agg(l.name ORDER BY l.name) FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id) AS labels
           FROM issues i JOIN projects p ON p.id = i.project_id LEFT JOIN issues par ON par.id = i.parent_id LEFT JOIN modules m ON m.id = i.module_id
          WHERE p.key = $1 AND i.number = $2 AND i.deleted_at IS NULL`,
        [key, number],
      )
    ).rows[0];

  it('GET import-template.xlsx: คอลัมน์เดียวกับ Export ไม่มีงาน · มีรายชื่อสมาชิก · Guest ไม่ได้', async () => {
    const res = await download(team.lead, `${team.ws}/import-template.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('friday-plan-template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const tasks = wb.getWorksheet('Tasks')!;
    expect((tasks.getRow(1).values as unknown[]).slice(1)).toEqual(TASK_HEADERS);
    expect(tasks.rowCount).toBe(1);
    expect(wb.getWorksheet('ค่าที่ใช้ได้')!.getColumn(5).values.slice(2)).toEqual(expect.arrayContaining(['Mick', 'Kaijeaw']));
    expect(wb.getWorksheet('คำแนะนำ')!.rowCount).toBeGreaterThan(10);
    // Template ว่างอัปโหลดได้ (ไม่มีแถวงาน) โดยไม่ต้องแก้หัวคอลัมน์
    const up = await team.lead.upload(`${team.ws}/import-jobs`, res.body, 'template.xlsx', { mode: 'create' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.columns.filter((c: { field: string | null }) => c.field)).toHaveLength(TASK_HEADERS.length);
  });

  it('สร้างโปรเจกต์: Key ว่าง = ออกเลขให้ · Parent Key = Sub-task (Module ตามแม่) · SA / QA / Priority / Label', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tasks');
    ws.addRow(TASK_HEADERS);
    ws.addRow(row({ Key: 'T-1', Module: 'Core', Title: 'Parent A', Status: 'In Progress', Priority: 'High', 'Business Analyst': 'Mick', 'System Analyst': 'Kaijeaw', Developer: 'Kaijeaw', 'QA / Reviewer': 'Mick', 'Man-Day': 4, 'Plan Start': d('2026-11-09'), Requirement: 'FR-001', Screen: 'SCR-001', Label: 'api, ui', Description: 'งานแม่', Remark: 'รอยืนยันจากลูกค้าสมมติ' }));
    ws.addRow(row({ 'Parent Key': 'T-1', Module: 'อื่น', Title: 'Child A1', Developer: 'Kaijeaw', 'Man-Day': 1, 'Plan Start': d('2026-11-30') }));
    ws.addRow(row({ Module: 'Core', Title: 'Standalone', Priority: 'ไม่รู้จัก' }));
    ws.addRow(row({ 'Parent Key': 'T-99', Title: 'แม่ไม่มีจริง' }));
    const up = await team.lead.upload(`${team.ws}/import-jobs`, Buffer.from(await wb.xlsx.writeBuffer()), 'Keyed.xlsx', { mode: 'create' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const problems = up.body.findings.map((f: { level: string; problem: string }) => `${f.level}:${f.problem}`);
    expect(problems).toEqual(expect.arrayContaining(['err:ไม่พบ Task แม่ 99', 'warn:Module "อื่น" ไม่ตรงกับ Task แม่', 'warn:วันที่อยู่นอกช่วงของ Task แม่ 1', 'warn:Priority "ไม่รู้จัก" ไม่รู้จัก']));
    expect(up.body.summary).toMatchObject({ rows: 4, skipped: 1, subtasks: 1 });
    expect(up.body.people.find((p: { name: string }) => p.name === 'Mick').roles.sort()).toEqual(['ba', 'qa']);
    expect((await team.lead.patch(`${team.ws}/import-jobs/${up.body.id}`, { project: { key: 'KEY', name: 'Keyed' } })).status).toBe(200);
    expect(await commit(up.body.id)).toMatchObject({ imported: 3, skipped: 1 });

    expect(await issueRow('KEY', 1)).toMatchObject({ title: 'Parent A', priority: 'high', parent: null, module: 'Core', sa_id: team.devId, reviewer_id: team.leadId, ba_id: team.leadId, labels: ['api', 'ui'], excel_row_no: null });
    expect(await issueRow('KEY', 2)).toMatchObject({ title: 'Child A1', parent: 1, module: 'Core', priority: 'medium' });
    expect(await issueRow('KEY', 3)).toMatchObject({ title: 'Standalone', parent: null, labels: null });
    // รายละเอียด → Description · Remark → Remark แยกกัน (ผู้ใช้ตัดสิน 2026-11-09)
    expect((await t.owner.query(`SELECT i.description, i.remark FROM issues i JOIN projects p ON p.id = i.project_id WHERE p.key = 'KEY' AND i.number = 1`)).rows[0]).toEqual({ description: 'งานแม่', remark: 'รอยืนยันจากลูกค้าสมมติ' });
    expect((await team.lead.post(`${team.ws}/projects/KEY/issues`, { title: 'ถัดไป', moduleId: (await team.lead.get(`${team.ws}/issues/KEY-1`)).body.moduleId })).body.key).toBe('KEY-4');
  });

  it('Group: สร้างกลุ่มตามไฟล์ · Sub-task อยู่กลุ่มเดียวกับแม่ · ย้าย Task ไปกลุ่มอื่นแล้ว Sub-task ตาม', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tasks');
    ws.addRow(TASK_HEADERS);
    ws.addRow(row({ Key: 'G-1', Module: 'Core', Group: 'กลุ่ม A', Title: 'Task ในกลุ่ม' }));
    ws.addRow(row({ 'Parent Key': 'G-1', Title: 'Sub ในกลุ่ม' }));
    ws.addRow(row({ Module: 'Core', Title: 'Task ไม่มีกลุ่ม' }));
    const up = await team.lead.upload(`${team.ws}/import-jobs`, Buffer.from(await wb.xlsx.writeBuffer()), 'Grp.xlsx', { mode: 'create' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.summary.phases).toBe(1);
    await team.lead.patch(`${team.ws}/import-jobs/${up.body.id}`, { project: { key: 'GRP', name: 'Groups' } });
    await commit(up.body.id);
    const groups = async () => (await t.owner.query(`SELECT i.number, ph.name FROM issues i JOIN projects p ON p.id = i.project_id LEFT JOIN phases ph ON ph.id = i.phase_id WHERE p.key = 'GRP' ORDER BY i.number`)).rows;
    expect(await groups()).toEqual([{ number: 1, name: 'กลุ่ม A' }, { number: 2, name: 'กลุ่ม A' }, { number: 3, name: null }]);

    const file = await edit(await exportOf('GRP'), (sheet) => {
      expect(sheet.getRow(2).getCell(col('Group')).value).toBe('กลุ่ม A');
      sheet.getRow(2).getCell(col('Group')).value = 'กลุ่ม B';
    });
    const job = await updateJob('GRP', file);
    expect(job.diff.changed.map((c: { key: string; fields: { field: string }[] }) => [c.key, c.fields.map((f) => f.field)])).toEqual([['GRP-1', ['group']]]);
    await commit(job.id);
    expect(await groups()).toEqual([{ number: 1, name: 'กลุ่ม B' }, { number: 2, name: 'กลุ่ม B' }, { number: 3, name: null }]);
  });

  it('อัปเดต: เปลี่ยน SA / Label / Task แม่ · เพิ่ม Sub-task ใหม่ · Task ที่มี Sub-task เป็น Sub-task ไม่ได้ · Key ต่างโปรเจกต์ผิด', async () => {
    const file = await edit(await exportOf('KEY'), (ws) => {
      expect(ws.getRow(3).getCell(col('Key')).value).toBe('KEY-2'); // Sub-task ต่อท้าย Task แม่
      ws.getRow(2).getCell(col('System Analyst')).value = 'Mick'; // SA ของ KEY-1
      ws.getRow(2).getCell(col('Label')).value = 'api';
      expect(ws.getRow(2).getCell(col('Description')).value).toBe('งานแม่');
      ws.getRow(2).getCell(col('Remark')).value = 'นัดคุยวันศุกร์';
      ws.getRow(3).getCell(col('Parent Key')).value = 'KEY-3'; // ย้าย KEY-2 ไปอยู่ใต้ KEY-3
      ws.addRow(row({ 'Parent Key': 'KEY-3', Title: 'Child B' }));
      ws.addRow(row({ Key: 'ZZ-1', Module: 'Core', Title: 'ผิดโปรเจกต์' }));
    });
    const job = await updateJob('KEY', file);
    expect(job.diff.changed.map((c: { key: string; fields: { field: string; old: unknown; new: unknown }[] }) => [c.key, c.fields.map((f) => [f.field, f.old, f.new])])).toEqual([
      ['KEY-1', [['sa', 'Kaijeaw', 'Mick'], ['labels', ['api', 'ui'], ['api']], ['remark', 'รอยืนยันจากลูกค้าสมมติ', 'นัดคุยวันศุกร์']]],
      ['KEY-2', [['parent', 'KEY-1', 'KEY-3']]],
    ]);
    expect(job.diff.added.map((a: { title: string }) => a.title)).toEqual(['Child B']);
    expect(job.diff.missing).toEqual([]); // KEY-4 ที่สร้างในระบบอยู่ในไฟล์ Export แล้ว
    expect(job.findings.some((f: { level: string; problem: string }) => f.level === 'err' && f.problem.includes('ไม่ใช่งานของโปรเจกต์ KEY'))).toBe(true);
    expect(await commit(job.id)).toMatchObject({ added: 1, changed: 2, kept: 0 });
    expect(await issueRow('KEY', 1)).toMatchObject({ sa_id: team.leadId, labels: ['api'] });
    expect(await issueRow('KEY', 2)).toMatchObject({ parent: 3 });
    expect(await issueRow('KEY', 5)).toMatchObject({ title: 'Child B', parent: 3, module: 'Core' });

    const bad = await updateJob('KEY', await edit(await exportOf('KEY'), (ws) => {
      expect(ws.getRow(3).getCell(col('Key')).value).toBe('KEY-3');
      ws.getRow(3).getCell(col('Parent Key')).value = 'KEY-1'; // KEY-3 มี Sub-task (KEY-2, KEY-5) อยู่
    }));
    expect(bad.findings.some((f: { level: string; problem: string }) => f.level === 'err' && f.problem.includes('มี Sub-task อยู่'))).toBe(true);
    expect(bad.diff.changed).toEqual([]);
  });
});
