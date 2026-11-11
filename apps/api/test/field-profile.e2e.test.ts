// Template ของโปรเจกต์ + ชุดฟิลด์ (Task / Sub-task แสดง / บังคับฟิลด์ต่างกัน, คอลัมน์ Table) + ค่า Custom field ของงาน
// ข้อมูลสมมติเท่านั้น
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, client, type Client, seedTeam, signup, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let team: Awaited<ReturnType<typeof seedTeam>>;

beforeAll(async () => {
  t = await startApp();
  team = await seedTeam(t);
});
afterAll(() => t.close());

const P = () => `${team.ws}/projects/${team.key}`;
const I = (key: string) => `${team.ws}/issues/${key}`;
const moduleId = () => team.project.modules[0].id as string;

async function sheetHeaders(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Tasks')!;
  return { headers: (ws.getRow(1).values as unknown[]).slice(1).map(String), ws };
}
async function download(c: Client, url: string) {
  const res = await c.get(url).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (x: Buffer) => chunks.push(x));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res as typeof res & { body: Buffer };
}

describe('Template catalog', () => {
  it('สมาชิก (ไม่ใช่ Admin) เห็น Template ในตัว + ขององค์กร จัดตามหมวด · Guest ไม่ได้', async () => {
    expect((await team.lead.post(`${team.ws}/project-templates`, { name: 'Support Desk', description: 'งาน Support', config: { category: 'service', fields: { ba: { task: 'hidden', subtask: 'hidden' } } } })).status).toBe(201);
    const r = await team.dev.get(`${team.ws}/projects/template-catalog`);
    expect(r.status).toBe(200);
    expect(r.body.categories).toContain('software');
    const ids = r.body.items.map((x: { id: string }) => x.id);
    expect(ids.slice(0, 6)).toEqual(['development', 'development_qa', 'scrum', 'kanban', 'waterfall', 'blank']);
    const dev = r.body.items.find((x: { id: string }) => x.id === 'development');
    expect(dev).toMatchObject({ source: 'builtin', category: 'software', config: { sprintLengthWeeks: 2, columns: expect.arrayContaining(['ba', 'sa', 'remark']) } });
    expect(r.body.items.find((x: { name: string }) => x.name === 'Support Desk')).toMatchObject({ source: 'workspace', category: 'service', invalid: false });

    const guest = await client(t.app);
    const guestId = await signup(guest, 'guest@friday-dev.example.com', 'Guest');
    await addMember(t.owner, team.slug, guestId, 'guest');
    expect((await guest.get(`${team.ws}/projects/template-catalog`)).status).toBe(403);
  });

  it('Admin สร้าง Template ขององค์กรจาก Template ในตัวได้ · ตั้ง required ให้ฟิลด์ที่บังคับไม่ได้ = 400', async () => {
    const r = await team.lead.post(`${team.ws}/project-templates`, { name: 'Dev ของเรา', fromBuiltin: 'development', config: { fields: { sa: { task: 'required', subtask: 'hidden' } } } });
    expect(r.status).toBe(201);
    expect(r.body.config).toMatchObject({ sprintLengthWeeks: 2, workflow: ['To do', 'In progress', 'Review', 'Done'], fields: { sa: { task: 'required', subtask: 'hidden' }, ba: { task: 'optional' } } });
    const bad = await team.lead.post(`${team.ws}/project-templates`, { name: 'ผิด', config: { fields: { actual: { task: 'required' } } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('field_not_requirable');
  });
});

describe('สร้างโปรเจกต์จาก Template', () => {
  it('Development: ได้ชุดฟิลด์ / คอลัมน์ของ Development Plan และ Sprint 2 สัปดาห์ · บอกที่มาของ Template', async () => {
    const r = await team.lead.post(`${team.ws}/projects`, { name: 'Dev Tpl', key: 'DVT', startDate: '2026-11-09', goliveDate: '2027-01-29', builtinTemplate: 'development' });
    expect(r.status).toBe(201);
    expect(r.body.sprintLengthWeeks).toBe(2);
    const p = (await team.lead.get(`${team.ws}/projects/DVT`)).body;
    expect(p.fieldProfile.template).toEqual({ id: 'development', name: 'Development', builtin: true });
    expect(p.fieldProfile.columns).toEqual(['dev', 'ba', 'sa', 'status', 'size', 'start', 'end', 'actualStart', 'actualEnd', 'progress', 'remark']);
    expect(p.fieldProfile.fields.ba).toEqual({ task: 'optional', subtask: 'optional' });
    expect(p.statuses.filter((s: { workflowId: string }) => s.workflowId === p.statuses[0].workflowId).map((s: { name: string }) => s.name)).toEqual(['To do', 'In progress', 'Review', 'Done']);
  });

  it('ส่ง templateId กับ builtinTemplate พร้อมกันไม่ได้', async () => {
    const tpl = (await team.lead.get(`${team.ws}/project-templates`)).body.items[0];
    const r = await team.lead.post(`${team.ws}/projects`, { name: 'X', key: 'XX', startDate: '2026-11-09', goliveDate: '2026-12-30', builtinTemplate: 'scrum', templateId: tpl.id });
    expect(r.status).toBe(400);
  });

  it('Template ขององค์กร: Custom field ระดับ Task / Sub-task + คอลัมน์อ้าง Custom field ด้วยชื่อ · Member สร้างได้', async () => {
    const tpl = await team.lead.post(`${team.ws}/project-templates`, {
      name: 'Ops Lite',
      config: {
        category: 'operations',
        fields: { ba: { task: 'hidden', subtask: 'hidden' }, sa: { task: 'hidden', subtask: 'hidden' }, size: { task: 'required', subtask: 'hidden' }, remark: { subtask: 'required' } },
        customFields: [
          { name: 'ลูกค้า', fieldType: 'text', taskMode: 'required', subtaskMode: 'hidden' },
          { name: 'ระดับ', fieldType: 'select', options: { choices: [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }] } },
        ],
        columns: ['dev', 'ba', 'status', 'cf:ลูกค้า', 'cf:ระดับ', 'size', 'end'],
      },
    });
    expect(tpl.status).toBe(201);
    // สมาชิกทั่วไปสร้างโปรเจกต์จาก Template ขององค์กรได้ (RLS อ่าน Template ได้ทุกสมาชิก)
    const r = await team.dev.post(`${team.ws}/projects`, { name: 'Ops', key: 'OPS', startDate: '2026-11-09', goliveDate: '2027-01-29', templateId: tpl.body.id, members: [{ userId: team.leadId, role: 'admin' }] });
    expect(r.status).toBe(201);
    const p = (await team.dev.get(`${team.ws}/projects/OPS`)).body;
    const cust = p.customFields.find((f: { name: string }) => f.name === 'ลูกค้า');
    const level = p.customFields.find((f: { name: string }) => f.name === 'ระดับ');
    expect(cust).toMatchObject({ fieldType: 'text', taskMode: 'required', subtaskMode: 'hidden' });
    // ba ซ่อนทั้งสองระดับ คอลัมน์จึงถูกตัด · cf:<ชื่อ> แปลงเป็น cf:<id>
    expect(p.fieldProfile.columns).toEqual(['dev', 'status', `cf:${cust.id}`, `cf:${level.id}`, 'size', 'end']);
    expect(p.fieldProfile.template).toMatchObject({ name: 'Ops Lite', builtin: false });
    expect(p.fieldProfile.fields.size).toEqual({ task: 'required', subtask: 'hidden' });
  });
});

describe('ชุดฟิลด์บังคับใช้ตอนสร้าง / แก้งาน', () => {
  let custId: string;
  let levelId: string;
  const OPS = () => `${team.ws}/projects/OPS`;

  beforeAll(async () => {
    const p = (await team.lead.get(OPS())).body;
    custId = p.customFields.find((f: { name: string }) => f.name === 'ลูกค้า').id;
    levelId = p.customFields.find((f: { name: string }) => f.name === 'ระดับ').id;
    const mod = await team.lead.post(`${OPS()}/modules`, { name: 'Core' });
    expect(mod.status).toBe(201);
  });
  const opsModule = async () => (await team.lead.get(OPS())).body.modules[0].id as string;

  it('Task: ฟิลด์บังคับ (Size, Custom field) ไม่ครบ = 400 พร้อมรายชื่อฟิลด์', async () => {
    const r = await team.lead.post(`${OPS()}/issues`, { title: 'ตั้งค่าเครื่อง', moduleId: await opsModule() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('missing_required_fields');
    expect(r.body.error.details.fields).toEqual(['size']);
    const r2 = await team.lead.post(`${OPS()}/issues`, { title: 'ตั้งค่าเครื่อง', moduleId: await opsModule(), size: 'S' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.details.fields).toEqual(['ลูกค้า']);
  });

  it('Task: ฟิลด์ที่ซ่อน (BA) ส่งค่ามา = 422 field_hidden · ครบแล้วสร้างได้และคืนค่า Custom field', async () => {
    const hidden = await team.lead.post(`${OPS()}/issues`, { title: 'A', moduleId: await opsModule(), size: 'S', baId: team.leadId, customFields: { [custId]: 'ร้าน ก' } });
    expect(hidden.status).toBe(422);
    expect(hidden.body.error).toMatchObject({ code: 'field_hidden', details: { fields: ['ba'] } });
    const ok = await team.lead.post(`${OPS()}/issues`, { title: 'A', moduleId: await opsModule(), size: 'S', customFields: { [custId]: '  ร้าน ก  ', [levelId]: 'p1' } });
    expect(ok.status).toBe(201);
    expect(ok.body.customFields).toEqual({ [custId]: 'ร้าน ก', [levelId]: 'p1' });
  });

  it('Sub-task ใช้กฎของระดับ Sub-task: Size / ลูกค้า ซ่อน, Remark บังคับ', async () => {
    const parent = (await team.lead.get(`${OPS()}/issues?limit=10`)).body.items.find((x: { parentKey: string | null }) => !x.parentKey).key;
    const noRemark = await team.lead.post(`${OPS()}/issues`, { title: 'ย่อย', parentKey: parent });
    expect(noRemark.status).toBe(400);
    expect(noRemark.body.error.details.fields).toEqual(['remark']);
    const sizeHidden = await team.lead.post(`${OPS()}/issues`, { title: 'ย่อย', parentKey: parent, remark: 'ทำตามคู่มือ', size: 'XS' });
    expect(sizeHidden.status).toBe(422);
    const custHidden = await team.lead.post(`${OPS()}/issues`, { title: 'ย่อย', parentKey: parent, remark: 'ทำตามคู่มือ', customFields: { [custId]: 'x' } });
    expect(custHidden.status).toBe(422);
    expect(custHidden.body.error.details.fields).toEqual(['ลูกค้า']);
    const ok = await team.lead.post(`${OPS()}/issues`, { title: 'ย่อย', parentKey: parent, remark: 'ทำตามคู่มือ' });
    expect(ok.status).toBe(201);
  });

  it('แก้งาน: ล้างฟิลด์บังคับไม่ได้ · ค่า Custom field แก้ / ล้างได้ · บันทึก Activity และเพิ่ม version', async () => {
    const task = (await team.lead.get(`${OPS()}/issues?limit=10`)).body.items.find((x: { parentKey: string | null }) => !x.parentKey);
    const clear = await team.lead.patch(I(task.key), { customFields: { [custId]: null } }, task.version);
    expect(clear.status).toBe(400);
    expect(clear.body.error.details.fields).toEqual(['ลูกค้า']);
    expect((await team.lead.patch(I(task.key), { size: null }, task.version)).status).toBe(400);
    const badChoice = await team.lead.patch(I(task.key), { customFields: { [levelId]: 'p9' } }, task.version);
    expect(badChoice.status).toBe(400);
    expect(badChoice.body.error.code).toBe('invalid_custom_field');
    const ok = await team.lead.patch(I(task.key), { customFields: { [levelId]: 'p2', [custId]: 'ร้าน ข' } }, task.version);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(task.version + 1);
    expect(ok.body.customFields).toEqual({ [custId]: 'ร้าน ข', [levelId]: 'p2' });
    const cleared = await team.lead.patch(I(task.key), { customFields: { [levelId]: null } }, ok.body.version);
    expect(cleared.body.customFields).toEqual({ [custId]: 'ร้าน ข' });
    const { rows } = await t.owner.query(`SELECT field, old_value, new_value FROM activities WHERE issue_id = $1 AND field LIKE 'cf:%' ORDER BY created_at`, [task.id]);
    // Activity เก็บชื่อตัวเลือก (P2) ไม่ใช่ id
    expect(rows).toEqual(expect.arrayContaining([
      { field: `cf:${levelId}`, old_value: 'P1', new_value: 'P2' },
      { field: `cf:${custId}`, old_value: 'ร้าน ก', new_value: 'ร้าน ข' },
      { field: `cf:${levelId}`, old_value: 'P2', new_value: null },
    ]));
    // ส่งค่าเดิมของฟิลด์ที่ซ่อนซ้ำได้ (ไม่ถือว่าเขียนใหม่) · ค่าใหม่ไม่ได้
    expect((await team.lead.patch(I(task.key), { baId: null }, cleared.body.version)).status).toBe(200);
    const again = (await team.lead.get(I(task.key))).body;
    expect((await team.lead.patch(I(task.key), { baId: team.devId }, again.version)).status).toBe(422);
  });

  it('Custom field ชนิดคน ต้องเป็นสมาชิก Workspace · ชนิดตัวเลข / วันที่ ตรวจรูปแบบ', async () => {
    const who = await team.lead.post(`${OPS()}/custom-fields`, { name: 'ผู้ติดต่อ', fieldType: 'user' });
    const num = await team.lead.post(`${OPS()}/custom-fields`, { name: 'จำนวนเครื่อง', fieldType: 'number', subtaskMode: 'hidden' });
    const date = await team.lead.post(`${OPS()}/custom-fields`, { name: 'วันนัด', fieldType: 'date' });
    expect([who.status, num.status, date.status]).toEqual([201, 201, 201]);
    expect(num.body).toMatchObject({ taskMode: 'optional', subtaskMode: 'hidden' });
    const task = (await team.lead.get(`${OPS()}/issues?limit=10`)).body.items.find((x: { parentKey: string | null }) => !x.parentKey);
    const stranger = '00000000-0000-4000-8000-000000000000';
    expect((await team.lead.patch(I(task.key), { customFields: { [who.body.id]: stranger } }, task.version)).body.error.code).toBe('invalid_people');
    expect((await team.lead.patch(I(task.key), { customFields: { [num.body.id]: 'abc' } }, task.version)).status).toBe(400);
    expect((await team.lead.patch(I(task.key), { customFields: { [date.body.id]: '09/11/2026' } }, task.version)).status).toBe(400);
    const ok = await team.lead.patch(I(task.key), { customFields: { [who.body.id]: team.devId, [num.body.id]: '3', [date.body.id]: '2026-11-20' } }, task.version);
    expect(ok.status).toBe(200);
    expect(ok.body.customFields).toMatchObject({ [who.body.id]: team.devId, [num.body.id]: 3, [date.body.id]: '2026-11-20' });
    // ฟิลด์ใหม่ขึ้นเป็นคอลัมน์ท้ายสุดของ Table · ยกเว้นฟิลด์ที่ซ่อนทั้งสองระดับ
    const cols = (await team.lead.get(`${OPS()}/field-profile`)).body.fieldProfile.columns;
    expect(cols.slice(-3)).toEqual([`cf:${who.body.id}`, `cf:${num.body.id}`, `cf:${date.body.id}`]);
  });

  it('Table (GET issues) คืนค่า Custom field ของแต่ละแถว', async () => {
    const r = await team.lead.get(`${OPS()}/issues?view=table&limit=50`);
    expect(r.status).toBe(200);
    const task = r.body.items.find((x: { parentKey: string | null }) => !x.parentKey);
    expect(task.customFields[custId]).toBe('ร้าน ข');
  });

  it('Bug ไม่ใช้ชุดฟิลด์ของ Task (ใช้ฟิลด์บังคับของประเภทงาน)', async () => {
    const r = await team.lead.post(`${OPS()}/issues`, { type: 'Bug', title: 'ปุ่มกดไม่ได้', moduleId: await opsModule(), severity: 'major', environment: 'sit', details: { steps: '1. เปิดหน้า' } });
    expect(r.status).toBe(201);
  });
});

describe('แก้ชุดฟิลด์ใน Settings', () => {
  it('PM แก้ได้ · Member ไม่ได้ · ซ่อนฟิลด์แล้วคอลัมน์หาย ค่าเดิมยังอยู่ · เปิดกลับได้ค่าเดิม', async () => {
    const created = await team.lead.post(`${P()}/issues`, { title: 'งาน SA', moduleId: moduleId(), saId: team.devId });
    expect(created.status).toBe(201);
    expect((await team.dev.put(`${P()}/field-profile`, { fields: { sa: { task: 'hidden' } } })).status).toBe(403);
    const hide = await team.lead.put(`${P()}/field-profile`, { fields: { sa: { task: 'hidden', subtask: 'hidden' } } });
    expect(hide.status).toBe(200);
    expect(hide.body.fieldProfile.fields.sa).toEqual({ task: 'hidden', subtask: 'hidden' });
    expect(hide.body.fieldProfile.columns).not.toContain('sa');
    // ค่าเดิมยังเก็บไว้ (ตัดสินใจข้อ 3: ซ่อนแต่ไม่ลบ)
    expect((await team.lead.get(I(created.body.key))).body.saId).toBe(team.devId);
    const show = await team.lead.put(`${P()}/field-profile`, { fields: { sa: { task: 'optional', subtask: 'optional' } }, columns: ['dev', 'sa', 'status', 'nope', 'dev'] });
    expect(show.body.fieldProfile.columns).toEqual(['dev', 'sa', 'status']);
    expect((await team.lead.get(I(created.body.key))).body.saId).toBe(team.devId);
    expect((await team.lead.put(`${P()}/field-profile`, { fields: { progress: { task: 'required' } } })).body.error.code).toBe('field_not_requirable');
    expect((await team.lead.put(`${P()}/field-profile`, {})).status).toBe(400);
  });

  it('โปรเจกต์เดิม (ไม่มีชุดฟิลด์) ได้ค่าเริ่มต้นเหมือนก่อนมีฟีเจอร์', async () => {
    await t.owner.query(`UPDATE projects SET field_profile = '{}'::jsonb WHERE key = $1`, [team.key]);
    const r = await team.dev.get(`${P()}/field-profile`);
    expect(r.status).toBe(200);
    expect(r.body.fieldProfile).toMatchObject({ columns: ['dev', 'ba', 'sa', 'status', 'size', 'start', 'end', 'actualStart', 'actualEnd', 'progress', 'remark'], template: null });
    expect(Object.values(r.body.fieldProfile.fields).every((v) => JSON.stringify(v) === JSON.stringify({ task: 'optional', subtask: 'optional' }))).toBe(true);
  });

  it('form-options มีชุดฟิลด์และ Custom field ให้ฟอร์มสร้างงาน', async () => {
    const r = await team.lead.get(`${team.ws}/projects/OPS/form-options`);
    expect(r.status).toBe(200);
    expect(r.body.fieldProfile.fields.size.task).toBe('required');
    expect(r.body.customFields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['ลูกค้า', 'ระดับ']));
  });
});

describe('Export ตามชุดฟิลด์', () => {
  it('ไม่ส่งออกคอลัมน์ที่ซ่อนทั้งสองระดับ · เพิ่มคอลัมน์ Custom field พร้อมค่าที่อ่านได้', async () => {
    const r = await download(team.lead, `${team.ws}/projects/OPS/export.xlsx`);
    expect(r.status).toBe(200);
    const { headers, ws } = await sheetHeaders(r.body);
    expect(headers).not.toContain('Business Analyst');
    expect(headers).not.toContain('System Analyst');
    expect(headers).toContain('Size');
    expect(headers).toEqual(expect.arrayContaining(['ลูกค้า', 'ระดับ', 'ผู้ติดต่อ', 'จำนวนเครื่อง', 'วันนัด']));
    const col = (h: string) => headers.indexOf(h) + 1;
    const row = ws.getRow(2);
    expect(row.getCell(col('ลูกค้า')).value).toBe('ร้าน ข');
    expect(row.getCell(col('ผู้ติดต่อ')).value).toBe('Kaijeaw');
    expect(row.getCell(col('จำนวนเครื่อง')).value).toBe(3);
  });

  it('โปรเจกต์ที่ไม่ได้ซ่อนอะไร ส่งออกคอลัมน์มาตรฐานครบเหมือนเดิม', async () => {
    const r = await download(team.lead, `${P()}/export.xlsx`);
    const { headers } = await sheetHeaders(r.body);
    expect(headers.slice(0, 22)).toEqual(['Key', 'Parent Key', 'Module', 'Group', 'Title', 'Status', 'Priority', 'Business Analyst', 'System Analyst', 'Developer', 'QA / Reviewer', 'Size', 'Man-Day', 'Plan Start', 'Plan End', 'Actual Start', 'Actual End', 'Requirement', 'Screen', 'Label', 'Description', 'Remark']);
  });
});
