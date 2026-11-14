/* Unified · ข้อมูลเพิ่มเติมและการปรับข้อมูลเดิม (ทำในหน่วยความจำของหน้านี้เท่านั้น ไม่แก้ไฟล์ต้นฉบับ)
 * ต้องโหลดหลัง ../claude-friday-mobile-complete/data/*.js */
(function () {
  const D = FM.def, defs = FM.defs;

  /* ---------- หน้าที่เพิ่มใหม่ในชุด unified (ไม่อยู่ใน inventory เดิม 189 รายการ) ---------- */
  FM.U_EXTRA = [
    { id: 'u.projects', module: 'workspace', type: 'screen', titleThai: 'รายการโปรเจกต์ (แท็บโปรเจกต์)', states: ['default', 'loading', 'empty', 'error'], sources: ['unified: ปลายทางของแท็บ "โปรเจกต์" (เดิมแท็บพาไป proj.overview ของโปรเจกต์เดียว)'], interactions: ['แตะการ์ด → proj.overview', 'สร้างโปรเจกต์ → ws.new-project', 'สลับโปรเจกต์ → ws.project-switch'], note: 'เพิ่มใหม่ (ข้อเสนอ) · ใช้ข้อมูลสมมติเดิม Mobile App / Web Core / Platform' },
    { id: 'u.iss-edit', module: 'issue', type: 'sheet', titleThai: 'แก้ไขงาน (sheet)', states: ['default', 'error', 'success'], sources: ['unified: ไม่มี sheet แก้ไขแยกในชุดเดิม (เดิมแก้ทีละฟิลด์ผ่าน iss.status-menu / iss.assignee / iss.date)'], interactions: ['บันทึก → toast + กลับ iss.detail', 'ช่องชื่อว่าง → error inline'], note: 'เพิ่มใหม่ (ข้อเสนอ) · ไม่แทนการแก้ทีละฟิลด์เดิม ทั้งสองทางยังอยู่' },
    { id: 'ops.abuse', module: 'ops', type: 'screen', titleThai: 'Abuse · รายงานการใช้งานผิด (canvas-only)', states: ['default', 'empty', 'loading'], sources: ['design/canvas/ops/Abuse.dc.html (มีใน Canvas · ยังไม่มี route ใน apps/ops-web)'], interactions: ['แตะรายการ → ops.workspace-detail', 'ระงับ → ops.ws-suspend'], note: 'CANVAS-ONLY · ไม่มีสัญญา API/route production · เนื้อหาเป็นข้อมูลสมมติ' },
  ];

  D('u.projects', { kind: 'list', nav: 'ws', tab: 'proj.overview', title: 'โปรเจกต์', subt: 'บริษัท ตัวอย่าง จำกัด · 3 โปรเจกต์', acts: [['search', 'ค้นหา', 'ws.command'], ['plus', 'สร้างโปรเจกต์', 'ws.new-project']],
    filters: [['ทั้งหมด', 3], ['ติดดาว', 2], ['เสี่ยง', 1]],
    groups: [{ h: 'ติดดาว', items: [
      { i: 'folder', t: 'Mobile App', s: 'Sprint 7 · ความคืบหน้า 64%', st: 'prog', who: '12 งานเปิด', m: 'เหลือ 4 วันทำการ', p: 64, go: 'proj.overview' },
      { i: 'folder', t: 'Web Core', s: 'ความคืบหน้า 41% · ช้ากว่า Baseline', tag: ['warn', 'เสี่ยง'], who: '9 งานเปิด', m: 'Milestone 2 ธ.ค.', p: 41, go: 'proj.overview' } ] },
      { h: 'อื่น ๆ', items: [{ i: 'folder', t: 'Platform', s: 'ความคืบหน้า 78%', st: 'rev', who: '4 งานเปิด', m: 'อัปเดตเมื่อวาน', p: 78, go: 'proj.overview' }] }],
    fab: { l: 'สร้างโปรเจกต์', go: 'ws.new-project' },
    empty: { i: 'folder', h: 'ยังไม่มีโปรเจกต์', p: 'สร้างโปรเจกต์แรก หรือนำเข้าแผนจาก Excel', cta: 'สร้างโปรเจกต์', go: 'ws.new-project' } });

  D('u.iss-edit', { kind: 'sheet', over: 'iss.detail', h: 'แก้ไข MOB-42', submit: 'บันทึกการแก้ไข', submitShort: 'บันทึก', ctxc: { i: 'edit', t: 'MOB-42 · Mobile App · Sprint 7', s: 'การเปลี่ยนกำหนดส่งหลัง Baseline จะสร้างคำขอเลื่อนแทน' },
    fields: [
      { l: 'ชื่องาน', req: 1, v: 'ออกแบบหน้าชำระเงินบนมือถือ', err: 'กรุณาใส่ชื่องาน' },
      { l: 'สถานะ', t: 'chips', v: 'กำลังทำ', o: ['ต้องทำ', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว'] },
      { l: 'ผู้รับผิดชอบ', t: 'select', v: 'สมชาย ใจดี', o: ['สมชาย ใจดี', 'นิดา พรหมมา', 'กฤษ ทองดี', 'วรรณา ศรีสุข'] },
      { l: 'ความสำคัญ', t: 'chips', v: 'สูง', o: ['ต่ำ', 'กลาง', 'สูง'] },
      { l: 'Man-Day', t: 'number', v: '2', h: 'ใช้ไปแล้ว 1.2 MD' },
      { l: 'รายละเอียด', t: 'textarea', v: 'รองรับ PromptPay QR และแนบสลิปโอน' } ],
    okMsg: 'บันทึก MOB-42 แล้ว', st: { error: { errB: 'บันทึกไม่สำเร็จ ตรวจช่องที่มีเครื่องหมายแดง', fields: null } } });
  // สถานะ error: ทำให้ช่องชื่อว่างเพื่อแสดง inline error
  defs['u.iss-edit'].st.error.fields = defs['u.iss-edit'].fields.map((f, i) => (i === 0 ? Object.assign({}, f, { v: '' }) : f));

  D('ops.abuse', { kind: 'list', back: true, nav: 'ops', tabs: true, title: 'Abuse', subt: 'รายงานการใช้งานผิด · canvas-only',
    banner: ['warn', '<b>Canvas-only</b> · หน้านี้มีใน design/canvas/ops/Abuse.dc.html แต่ยังไม่มี route ใน ops-web · ไม่มีสัญญา API · ตัวเลข/สถานะเป็นข้อมูลสมมติ'],
    search: 'ค้นหา Workspace หรืออีเมล', filters: [['รอตรวจ', 3], ['ทั้งหมด', 11], ['ระงับแล้ว', 2]],
    groups: [{ h: 'รอตรวจ', n: 3, items: [
      { i: 'alert', t: 'Startup X · ส่งอีเมลเชิญผิดปกติ', s: 'เชิญ 140 อีเมลใน 10 นาที', tag: ['bad', 'สูง'], m: '12 นาที', go: 'ops.workspace-detail' },
      { i: 'alert', t: 'Acme Demo · อัปโหลดไฟล์ซ้ำ', s: 'ไฟล์ 2.1 GB ใน 1 ชม. (Trial)', tag: ['warn', 'กลาง'], m: '1 ชม.', go: 'ops.workspace-detail' },
      { i: 'flag', t: 'ผู้ใช้รายงาน: ข้อความสแปมในความเห็น', s: 'จาก Workspace บริษัท ทดลอง', tag: ['mute', 'ต่ำ'], m: 'เมื่อวาน', go: 'ops.ws-suspend' } ] }],
    empty: { i: 'shield', h: 'ไม่มีรายงานรอตรวจ', p: 'รายงานใหม่จะแสดงที่นี่' } });

  FM.U_EXTRA.forEach((e) => (FM.inv[e.id] = Object.assign({ extra: true }, e)));

  /* ---------- ปรับข้อมูลเดิมเพื่อให้โฟลว์ unified ต่อกัน (ในหน่วยความจำ) ---------- */
  FM.U_ADAPT = {};
  const note = (id, s) => ((FM.U_ADAPT[id] = FM.U_ADAPT[id] || []).push(s));
  if (defs['ws.home']) { defs['ws.home'].fab = defs['ws.home'].fab || { l: 'สร้างงาน', go: 'iss.create' }; note('ws.home', 'B ไม่มี quick actions ของ C → เพิ่ม FAB "สร้างงาน" ให้เอื้อมถึงได้ด้วยนิ้วโป้ง'); }
  if (defs['iss.detail']) { defs['iss.detail'].acts = [['edit', 'แก้ไขงาน', 'u.iss-edit'], ...(defs['iss.detail'].acts || [])]; note('iss.detail', 'เพิ่มปุ่ม "แก้ไขงาน" บนหัวหน้า → u.iss-edit'); }
  if (defs['iss.more'] && Array.isArray(defs['iss.more'].items)) { defs['iss.more'].items.unshift({ i: 'edit', l: 'แก้ไขงาน', go: 'u.iss-edit' }); note('iss.more', 'เพิ่มเมนู "แก้ไขงาน" ด้านบนสุด'); }
  if (defs['ops.menu'] && Array.isArray(defs['ops.menu'].items)) { defs['ops.menu'].items.push({ i: 'shield', l: 'Abuse (canvas-only)', go: 'ops.abuse' }); note('ops.menu', 'เพิ่มทางเข้า ops.abuse (canvas-only)'); }
  ['ws.home', 'ws.my-tasks', 'ws.inbox', 'ws.profile', 'proj.overview'].forEach((id) => note(id, 'แท็บ "โปรเจกต์" ในแถบล่างพาไป u.projects (รายการโปรเจกต์) แทน proj.overview'));
})();
