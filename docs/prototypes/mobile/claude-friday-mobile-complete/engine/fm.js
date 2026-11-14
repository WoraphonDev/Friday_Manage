/* Friday Manage mobile design engine
 * หน้าจอทุกหน้าเป็นข้อมูล (data/*.js เรียก FM.def) · engine นี้มี "ชนิด" (kind) ของหน้า แต่ละชนิดมี layout 3 ทิศทาง A/B/C
 * A = กระชับ เน้นงาน · B = สงบ เน้นการ์ด · C = ตามบริบท เน้นการกระทำ
 * ไม่มีการเรียก API จริง ทุกการกระทำเป็นการเปลี่ยนหน้า/สถานะในต้นแบบเท่านั้น */
(function () {
  'use strict';
  const FM = (window.FM = window.FM || {});
  FM.defs = FM.defs || {};
  FM.inv = FM.inv || {};
  FM.def = (id, d) => { FM.defs[id] = d; };
  FM.defs_ = (o) => Object.assign(FM.defs, o);

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const J = (a, f) => (a || []).map(f).join('');
  const go = (id, st) => (id ? ` data-go="${id}"${st ? ` data-gst="${st}"` : ''}` : '');
  let uid = 0;
  const nid = () => 'u' + (++uid);
  // id ของฟอร์มต้องไม่ซ้ำข้ามกรอบ (โหมดเทียบ A·B·C มีหลายกรอบในหน้าเดียว) · ตั้งใหม่ทุกครั้งที่ render
  let FID = 'frm0';

  const P = {
    back: 'M15 18l-6-6 6-6', close: 'M18 6L6 18M6 6l12 12', menu: 'M4 6h16M4 12h16M4 18h16', more: 'M12 5h.01M12 12h.01M12 19h.01', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3', plus: 'M12 5v14M5 12h14',
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', task: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    filter: 'M3 5h18l-7 8v6l-4 2v-8z', cal: 'M3 6h18v15H3zM3 10h18M8 3v4M16 3v4', chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2', board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', gantt: 'M3 6h10M7 12h12M5 18h8', table: 'M3 4h18v16H3zM3 10h18M9 4v16', file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8', bolt: 'M13 2L3 14h9l-1 8 10-12h-9z', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6', check: 'M20 6L9 17l-5-5', alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', info: 'M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', mail: 'M4 5h16v14H4zM22 6l-10 7L2 6', clip: 'M21.4 11l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5', send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
    chev: 'M9 18l6-6-6-6', down: 'M6 9l6 6 6-6', clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2', flag: 'M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v12s-1 1-4 1-5-2-8-2-4 1-4 1', star: 'M12 2l3 7h7l-5.5 4.5 2 7.5L12 17l-6.5 4 2-7.5L2 9h7z', help: 'M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14M12 18h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', card: 'M2 5h20v14H2zM2 10h20', upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12', download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    bug: 'M9 7V6a3 3 0 0 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4M6.5 17.5L3 20M17.5 17.5L21 20', globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15',
    money: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', sparkle: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z', drag: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01', camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21', copy: 'M9 9h13v13H9zM5 15H2V2h13v3',
    key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4', phone: 'M5 2h14v20H5zM11 18h2', play: 'M5 3l14 9-14 9z', pause: 'M6 4h4v16H6zM14 4h4v16h-4z', server: 'M2 3h20v8H2zM2 13h20v8H2zM6 7h.01M6 17h.01', target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8', tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01', megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8',
  };
  const I = (n, s = 20) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[n] || P.info}"/></svg>`;

  const ST = { todo: 'ต้องทำ', prog: 'กำลังทำ', rev: 'รอตรวจ', done: 'เสร็จแล้ว', blk: 'ติดขัด', can: 'ยกเลิก', over: 'เลยกำหนด' };
  const pill = (s, l) => (s in ST ? `<span class="pill st-${s}">${esc(l || ST[s])}</span>` : `<span class="pill t-${s || 'mute'}">${esc(l)}</span>`);
  const tag = (t) => (t ? pill(t[0], t[1]) : '');
  const dot = (s) => `<span class="dot d-${s}" aria-hidden="true"></span>`;
  const hash = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const av = (n, big) => `<span class="av av${hash(n) % 5}${big ? ' l' : ''}" aria-label="${esc(n)}">${esc(String(n).slice(0, 2))}</span>`;
  const avs = (a) => `<span class="avs">${J(a, (n) => av(n))}</span>`;
  const sb = () => `<div class="sbar" aria-hidden="true"><span>9:41</span><span>●●● ▮</span></div>`;
  const banner = (b) => (b ? `<div class="banner ${b[0]}" role="${b[0] === 'bad' ? 'alert' : 'status'}">${I(b[0] === 'ok' ? 'check' : b[0] === 'info' ? 'info' : 'alert')}<div class="t">${b[1]}</div>${b[2] ? `<button class="btn sm"${b[3] ? go(b[3]) : ' data-st="default"'}>${esc(b[2])}</button>` : ''}</div>` : '');
  const toast = (m) => (m ? `<div class="toast" role="status">${I('check')}<span>${esc(m)}</span>${/ลบ|ย้าย|เสร็จ/.test(m) ? '<button class="lnk" data-st="default">เลิกทำ</button>' : ''}</div>` : '');
  const emptyB = (e) => { e = e || {}; return `<div class="empty"><div class="ill">${I(e.i || 'inbox', 32)}</div><h3>${esc(e.h || 'ยังไม่มีรายการ')}</h3><p>${esc(e.p || 'เมื่อมีข้อมูลจะแสดงที่นี่')}</p>${e.cta ? `<button class="btn p"${go(e.go)}>${esc(e.cta)}</button>` : ''}</div>`; };
  const skel = (v) => {
    const line = (w, h = 14) => `<div class="skel" style="width:${w}%;height:${h}px;margin:8px 0"></div>`;
    if (v === 'B') return `<div class="cards" aria-busy="true" aria-label="กำลังโหลด">${J([1, 2, 3], () => `<div class="card">${line(40)}${line(90, 18)}${line(60)}</div>`)}</div>`;
    if (v === 'C') return `<div aria-busy="true" aria-label="กำลังโหลด"><div class="hero skel" style="height:120px"></div><div class="pad">${J([1, 2, 3, 4, 5], () => line(100, 40))}</div></div>`;
    return `<div class="pad" aria-busy="true" aria-label="กำลังโหลด">${line(30)}${J([1, 2, 3, 4, 5, 6], () => `<div style="display:flex;gap:10px;align-items:center">${'<div class="skel" style="width:10px;height:10px;border-radius:50%"></div>'}<div style="flex:1">${line(80)}${line(40, 10)}</div></div>`)}</div>`;
  };

  /* ---------- กราฟ ---------- */
  function chart(c) {
    if (!c) return '';
    const lab = esc(c.label || 'กราฟ');
    if (c.t === 'line') {
      const all = [...c.data, ...(c.data2 || [])], max = Math.max(...all) || 1, n = c.data.length;
      const pts = (a) => a.map((v, i) => `${(i / (n - 1)) * 280 + 10},${110 - (v / max) * 95}`).join(' ');
      return `<svg class="chart" viewBox="0 0 300 130" role="img" aria-label="${lab}">${[0, 1, 2, 3].map((i) => `<line x1="10" x2="290" y1="${15 + i * 31.6}" y2="${15 + i * 31.6}" style="stroke:var(--border)"/>`).join('')}${c.data2 ? `<polyline points="${pts(c.data2)}" fill="none" style="stroke:var(--chart-neutral)" stroke-width="2" stroke-dasharray="4 4"/>` : ''}<polyline points="${pts(c.data)}" fill="none" style="stroke:var(--chart-primary)" stroke-width="2.5"/>${J(c.labels, (l, i) => `<text x="${(i / (n - 1)) * 280 + 10}" y="126" text-anchor="middle" style="fill:var(--muted);font-size:10px">${esc(l)}</text>`)}</svg>${c.leg ? `<div class="leg"><span><i style="background:var(--chart-primary)"></i>${esc(c.leg[0])}</span><span><i style="background:var(--chart-neutral)"></i>${esc(c.leg[1])}</span></div>` : ''}`;
    }
    if (c.t === 'donut') {
      const tot = c.data.reduce((a, b) => a + b, 0); let acc = 0;
      const cols = ['--chart-primary', '--status-progress-dot', '--status-done-dot', '--status-overdue-dot', '--chart-neutral'];
      return `<div style="display:flex;align-items:center;gap:16px"><svg width="110" height="110" viewBox="0 0 42 42" role="img" aria-label="${lab}">${J(c.data, (v, i) => { const s = `<circle cx="21" cy="21" r="15.9" fill="none" stroke-width="6" style="stroke:var(${cols[i % 5]})" stroke-dasharray="${(v / tot) * 100} ${100 - (v / tot) * 100}" stroke-dashoffset="${25 - acc}"/>`; acc += (v / tot) * 100; return s; })}<text x="21" y="23" text-anchor="middle" style="font-size:7px;font-weight:700;fill:var(--foreground)">${esc(c.center || tot)}</text></svg><div class="leg" style="flex-direction:column;gap:4px">${J(c.labels, (l, i) => `<span><i style="background:var(${cols[i % 5]})"></i>${esc(l)} · ${c.data[i]}</span>`)}</div></div>`;
    }
    if (c.t === 'hbar') {
      const max = c.max || Math.max(...c.data);
      return `<div role="img" aria-label="${lab}">${J(c.labels, (l, i) => `<div style="margin:8px 0"><div style="display:flex;font-size:13px;margin-bottom:4px"><span style="flex:1">${esc(l)}</span><b>${c.data[i]}${esc(c.unit || '')}</b></div><div class="bar-h"><i class="${c.data[i] > (c.warn || Infinity) ? 'over' : ''}" style="width:${Math.min(100, (c.data[i] / max) * 100)}%"></i></div></div>`)}</div>`;
    }
    const max = Math.max(...c.data) || 1, n = c.data.length, w = 300 / n;
    return `<svg class="chart" viewBox="0 0 300 130" role="img" aria-label="${lab}">${J(c.data, (v, i) => { const h = (v / max) * 100; return `<rect x="${i * w + w * 0.18}" y="${110 - h}" width="${w * 0.64}" height="${h}" rx="3" style="fill:var(${i === (c.hl ?? n - 1) ? '--chart-primary' : '--chart-primary-soft'})"/><text x="${i * w + w / 2}" y="126" text-anchor="middle" style="fill:var(--muted);font-size:10px">${esc(c.labels?.[i] ?? '')}</text>`; })}</svg>`;
  }

  /* ---------- นำทาง ---------- */
  const NAV = {
    ws: [['home', 'หน้าหลัก', 'ws.home'], ['task', 'งานของฉัน', 'ws.my-tasks'], ['folder', 'โปรเจกต์', 'proj.overview'], ['inbox', 'กล่องข้อความ', 'ws.inbox', 3], ['user', 'ฉัน', 'ws.profile']],
    ops: [['home', 'ภาพรวม', 'ops.m'], ['check', 'อนุมัติ', 'ops.m-approvals', 2], ['alert', 'เหตุขัดข้อง', 'ops.m-incidents', 1], ['money', 'การชำระ', 'ops.m-payments'], ['menu', 'เมนู', 'ops.menu']],
  };
  const SUB = {
    proj: [['proj.overview', 'ภาพรวม'], ['proj.board', 'บอร์ด'], ['proj.backlog', 'Backlog'], ['proj.table', 'ตาราง'], ['proj.timeline', 'ไทม์ไลน์'], ['proj.gantt', 'Gantt'], ['proj.calendar', 'ปฏิทิน'], ['proj.dashboard', 'แดชบอร์ด'], ['proj.reports', 'รายงาน'], ['proj.files', 'ไฟล์'], ['proj.members', 'สมาชิก'], ['proj.automation', 'อัตโนมัติ'], ['proj.plan-changes', 'เปลี่ยนแผน'], ['proj.import', 'นำเข้า'], ['proj.settings-general', 'ตั้งค่า']],
    pset: [['proj.settings-general', 'ทั่วไป'], ['proj.settings-workflow', 'Workflow'], ['proj.settings-types', 'ประเภทงาน'], ['proj.settings-modules', 'โมดูล'], ['proj.settings-perms', 'สิทธิ์'], ['proj.settings-notify', 'แจ้งเตือน'], ['proj.settings-integ', 'เชื่อมต่อ'], ['proj.import', 'นำเข้า'], ['proj.settings-export', 'ส่งออก'], ['proj.plan-changes', 'เปลี่ยนแผน'], ['ws.trash', 'ถังขยะ'], ['proj.settings-danger', 'โซนอันตราย']],
    profile: [['ws.profile', 'ข้อมูลส่วนตัว'], ['ws.profile-security', 'ความปลอดภัย'], ['ws.profile-notify', 'การแจ้งเตือน'], ['ws.profile-hours', 'เวลาทำงาน']],
    admin: [['adm.overview', 'ภาพรวม'], ['adm.projects', 'โปรเจกต์'], ['adm.teams', 'ทีม'], ['adm.std', 'มาตรฐาน'], ['adm.load', 'ภาระงาน'], ['adm.security', 'ความปลอดภัย'], ['adm.audit', 'Audit'], ['adm.data', 'ข้อมูล'], ['adm.notify', 'ช่องทาง'], ['adm.notify-templates', 'แม่แบบ'], ['adm.integ', 'เชื่อมต่อ'], ['adm.bill', 'Billing'], ['ws.trash', 'ถังขยะ']],
    bill: [['bill.overview', 'ภาพรวม'], ['bill.plans', 'แผน'], ['bill.checkout', 'ชำระเงิน']],
    help: [['help.center', 'บทความ'], ['help.tickets', 'ตั๋วของฉัน'], ['help.contact', 'ติดต่อ']],
    opsbiz: [['ops.business', 'MRR'], ['ops.adoption', 'การใช้งาน'], ['ops.funnel', 'Funnel']],
    opssup: [['ops.support', 'ตั๋ว'], ['ops.support-sessions', 'เซสชัน'], ['ops.support-settings', 'ตั้งค่า']],
    opsmoney: [['ops.payments', 'การชำระ'], ['ops.refunds', 'คืนเงิน'], ['ops.promotions', 'โปรโมชัน'], ['ops.entitlements', 'สิทธิ์']],
  };
  const MODNAV = { workspace: 'ws', project: 'ws', issue: 'ws', admin: 'ws', billing: 'ws', help: 'ws', ops: 'ops' };
  const OVER = { public: 'pub.landing', workspace: 'ws.home', project: 'proj.board', issue: 'iss.detail', admin: 'adm.overview', billing: 'bill.overview', help: 'help.center', ops: 'ops.m', auth: 'auth.login', system: 'ws.home' };

  function tabs(nav, cur, v) {
    const it = NAV[nav]; if (!it) return '';
    const b = (t) => `<button class="tab"${go(t[2])}${t[2] === cur ? ' aria-current="page"' : ''}>${I(t[0], 22)}<span>${t[1]}</span>${t[3] ? `<span class="bd">${t[3]}</span>` : ''}</button>`;
    if (v === 'C') {
      const mid = nav === 'ws' ? 'iss.create' : 'ops.m-approvals';
      return `<nav class="dock" aria-label="เมนูหลัก">${J(it.slice(0, 2), b)}<button class="mid"${go(mid)} aria-label="${nav === 'ws' ? 'สร้างงาน' : 'คิวอนุมัติ'}">${I(nav === 'ws' ? 'plus' : 'check', 24)}</button>${J(it.slice(2), b)}</nav>`;
    }
    return `<nav class="tabs ${v === 'B' ? 'b' : ''}" aria-label="เมนูหลัก">${J(it, b)}</nav>`;
  }
  function subnav(v, d, cur) {
    const it = SUB[d.sub]; if (!it) return '';
    const c = it.find((x) => x[0] === cur) || it[0];
    if (v === 'B') {
      if (d.sub === 'proj') return `<button class="vsel"${go('proj.view-switch')} aria-haspopup="dialog">${I('grid')}<span>มุมมอง <small>·</small> ${esc(c[1])}</span>${I('down')}</button>`;
      return `<details class="acc" style="margin:6px 12px;border:1px solid var(--border);border-radius:12px"><summary>${I('list')}<span>${esc(c[1])}</span><span class="k">${it.length} หมวด</span>${I('down')}</summary>${J(it, (x) => `<a class="mi" href="#"${go(x[0])}${x[0] === cur ? ' aria-current="page"' : ''}>${esc(x[1])}</a>`)}</details>`;
    }
    return `<nav class="subnav ${v === 'C' ? 'u' : ''}" aria-label="หมวด">${J(it, (x) => `<a href="#"${go(x[0])}${x[0] === cur ? ' aria-current="page"' : ''}>${esc(x[1])}</a>`)}</nav>`;
  }
  function topbar(v, d, r, navKind) {
    const t = esc(d.title || r.titleThai);
    const left = d.back ? `<button class="ib" data-back aria-label="ย้อนกลับ">${I('back')}</button>` : navKind === 'ws' ? `<button class="ib"${go('ws.switcher')} aria-label="สลับ Workspace"><span class="logo"><i></i><i></i><i></i><i></i></span></button>` : navKind === 'ops' ? `<button class="ib"${go('ops.menu')} aria-label="เมนู Ops">${I('menu')}</button>` : '';
    let acts = d.acts || (navKind === 'ws' && !d.back ? [['search', 'ค้นหา', 'ws.command'], ['bell', 'การแจ้งเตือน', 'ws.bell', 5]] : []);
    const A = J(acts, (a) => `<button class="ib"${go(a[2])} aria-label="${esc(a[1])}">${I(a[0])}${a[3] ? `<span class="bd">${a[3]}</span>` : ''}</button>`);
    if (v === 'B') return `<header class="bar b"><div class="row1">${left}<span class="sp"></span>${A}</div><h1>${t}</h1>${d.subt ? `<div class="subt">${esc(d.subt)}</div>` : ''}</header>`;
    if (v === 'C') {
      const ctx = d.ctx || (d.subt ? [[d.subt]] : []);
      return `<header class="bar c"><div class="row1">${left}<h1>${t}</h1>${A}</div>${ctx.length ? `<div class="ctx">${J(ctx, (c) => `<span>${c[1] != null ? `${esc(c[0])} <b>${esc(c[1])}</b>` : esc(c[0])}</span>`)}</div>` : ''}${d.csearch ? `<label class="srch">${I('search')}<input placeholder="${esc(d.csearch)}" aria-label="${esc(d.csearch)}"></label>` : ''}</header>`;
    }
    return `<header class="bar a">${left}<h1>${t}</h1>${A}</header>`;
  }

  /* ---------- รายการ ---------- */
  function lead(it, v) {
    if (it.av) return av(it.av);
    if (it.i) return `<span class="ill" style="width:36px;height:36px;border-radius:10px">${I(it.i, 18)}</span>`;
    if (it.st) return dot(it.st);
    return '';
  }
  const meta = (it) => `${it.tag ? tag(it.tag) : ''}${it.m ? `<span>${esc(it.m)}</span>` : ''}`;
  const itemA = (it) => `<button class="row${it.un ? ' un' : ''}"${go(it.go, it.gst)}>${lead(it)}<span class="t"><b>${it.k ? `<span class="k">${esc(it.k)}</span> ` : ''}${esc(it.t)}</b>${it.s ? `<small>${esc(it.s)}</small>` : ''}</span><span class="m">${meta(it)}</span>${it.go ? I('chev', 16) : ''}</button>`;
  const itemB = (it) => `<button class="card"${go(it.go, it.gst)}><div class="top">${it.st ? pill(it.st) : ''}${it.tag ? tag(it.tag) : ''}${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}${it.un ? '<span class="pill t-info">ใหม่</span>' : ''}</div><h3>${esc(it.t)}</h3>${it.s ? `<div class="mut sm">${esc(it.s)}</div>` : ''}${it.p != null ? `<div class="bar-h" style="margin-top:10px"><i style="width:${it.p}%"></i></div>` : ''}<div class="bot">${it.av ? av(it.av) : it.i ? I(it.i, 18) : ''}<span>${esc(it.who || '')}</span><span class="sp"></span><span>${esc(it.m || '')}</span></div></button>`;
  const itemC = (it, i, chk) => {
    const row = `<button class="row${it.un ? ' un' : ''}"${go(it.go, it.gst)}><span class="t"><b>${esc(it.t)}</b><small>${it.k ? esc(it.k) + ' · ' : ''}${esc(it.s || '')}</small></span><span class="m">${it.st ? pill(it.st) : ''}${meta(it)}</span></button>`;
    const c = chk && it.st ? `<input type="checkbox" class="chk" data-done aria-label="ทำเครื่องหมายเสร็จ: ${esc(it.t)}"${it.st === 'done' ? ' checked' : ''}>` : lead(it);
    const inner = `<div class="crow">${c}${row}</div>`;
    if (i === 0 && chk) return `<div class="sw-row open">${inner}<div class="sw-act"><button class="a1" data-toast="ทำเครื่องหมายเสร็จแล้ว">${I('check')}เสร็จ</button><button class="a2"${go('iss.due-request')}>${I('clock')}เลื่อน</button></div></div><div class="hs-hint">${I('back', 14)}ปัดซ้ายที่แถวเพื่อทำเสร็จหรือขอเลื่อน</div>`;
    return `<div class="sw-row">${inner}</div>`;
  };
  const groups = (d) => d.groups || (d.items ? [{ items: d.items }] : []);
  const secH = (g) => (g.h ? `<div class="sec">${esc(g.h)}${g.n != null ? ` <span class="pill t-mute">${g.n}</span>` : ''}${g.more ? `<button class="lnk"${go(g.more)}>ดูทั้งหมด</button>` : ''}</div>` : '');
  function listBody(d, v) {
    return J(groups(d), (g) => secH(g) + (v === 'B' ? `<div class="cards">${J(g.items, itemB)}</div>` : v === 'C' ? `<div class="grp">${J(g.items, (it, i) => itemC(it, i, d.check))}</div>` : `<div class="grp">${J(g.items, itemA)}</div>`));
  }
  const chipsBar = (f, cls = 'nw') => (f ? `<div class="chips ${cls}" data-single style="padding:8px 16px">${J(f, (x, i) => { const [l, n] = Array.isArray(x) ? x : [x]; return `<button class="chip" data-chip aria-pressed="${i === 0}">${esc(l)}${n != null ? ` <small>${n}</small>` : ''}</button>`; })}</div>` : '');
  const seg = (labels, id) => `<div class="seg ${labels.length > 3 ? 'sc' : ''}" role="tablist" data-tabs="${id}">${J(labels, (l, i) => `<button role="tab" data-tab="${i}" aria-selected="${i === 0}">${esc(l)}</button>`)}</div>`;
  const srch = (ph) => (ph ? `<label class="srch">${I('search')}<input type="search" placeholder="${esc(ph)}" aria-label="${esc(ph)}"></label>` : '');
  const heroB = (h) => (h ? `<section class="hero"><h2>${esc(h.h)}</h2>${h.p ? `<p>${esc(h.p)}</p>` : ''}${h.acts ? `<div class="acts">${J(h.acts, (a, i) => `<button class="btn ${i ? 'o' : ''}"${go(a.go)}>${a.i ? I(a.i, 18) : ''}${esc(a.l)}</button>`)}</div>` : ''}</section>` : '');
  const qa = (a) => (a ? `<div class="qa">${J(a, (x) => `<button${go(x.go)}>${I(x.i || 'plus', 22)}<span>${esc(x.l)}</span></button>`)}</div>` : '');
  const kpisA = (k) => (k ? `<div class="kpis">${J(k, (x) => `<div class="kpi"><span>${esc(x[0])}</span><b>${esc(x[1])}</b>${x[2] ? `<em class="${x[3] || 'up'}">${esc(x[2])}</em>` : ''}</div>`)}</div>` : '');
  const kpisC = (k) => (k ? `<div class="hk" tabindex="0" aria-label="ตัวชี้วัด เลื่อนแนวนอน">${J(k, (x) => `<div class="kpi"><span>${esc(x[0])}</span><b>${esc(x[1])}</b>${x[2] ? `<em class="${x[3] || 'up'}">${esc(x[2])}</em>` : ''}</div>`)}</div>` : '');

  /* ---------- ฟอร์ม ---------- */
  function field(f, s, inline) {
    const id = nid();
    const bad = s === 'error' && !!f.err;
    const lbl = `${esc(f.l)}${f.req ? ' <span class="req" aria-hidden="true">*</span>' : ''}`;
    const aria = ` id="${id}" aria-describedby="${id}e ${id}h"${bad ? ' aria-invalid="true"' : ''}${f.req ? ' data-req required' : ''}`;
    const errEl = `<div class="err" id="${id}e"${bad ? '' : ' hidden'}>${I('alert', 16)}<span>${esc(f.err || 'กรุณากรอก' + f.l)}</span></div>`;
    const hint = f.h ? `<div class="hint" id="${id}h">${esc(f.h)}</div>` : '';
    let c;
    switch (f.t) {
      case 'textarea': c = `<textarea class="in"${aria} placeholder="${esc(f.ph || '')}">${esc(f.v || '')}</textarea>`; break;
      case 'select': c = `<select class="in"${aria}>${J(f.o, (o) => `<option${o === f.v ? ' selected' : ''}>${esc(o)}</option>`)}</select>`; break;
      case 'otp': return `<div class="fld"><div class="lb" id="${id}l">${lbl}</div><div class="otp${bad ? ' bad' : ''}" role="group" aria-labelledby="${id}l">${J([0, 1, 2, 3, 4, 5], (i) => `<input inputmode="numeric" maxlength="1" autocomplete="${i ? 'off' : 'one-time-code'}" aria-label="หลักที่ ${i + 1}" value="${esc((f.v || '')[i] || '')}"${bad ? ' aria-invalid="true"' : ''}>`)}</div>${errEl}${hint}</div>`;
      case 'chips': return `<div class="fld"><div class="lb">${lbl}</div><div class="chips"${f.multi ? '' : ' data-single'} role="group" aria-label="${esc(f.l)}">${J(f.o, (o) => `<button type="button" class="chip" data-chip aria-pressed="${Array.isArray(f.v) ? f.v.includes(o) : o === f.v}">${esc(o)}</button>`)}</div>${errEl}${hint}</div>`;
      case 'radio': return `<fieldset class="fld" style="border:0;padding:0"><legend class="lb" style="margin-bottom:6px">${lbl}</legend>${J(f.o, (o) => { const [l, sub] = Array.isArray(o) ? o : [o]; return `<label class="radio"><input type="radio" name="${id}"${l === f.v ? ' checked' : ''}><span><b>${esc(l)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`; })}${errEl}</fieldset>`;
      case 'tog': return `<label class="sr-row" style="padding:4px 0;border-bottom:1px solid var(--border)"><span class="t">${esc(f.l)}${f.h ? `<small>${esc(f.h)}</small>` : ''}</span><input type="checkbox" class="sw" role="switch"${f.v ? ' checked' : ''}></label>`;
      case 'chk': return `<label class="cl"><input type="checkbox" class="chk"${f.v ? ' checked' : ''}${f.req ? ' data-req required' : ''}><span>${esc(f.l)}</span></label>${f.req ? errEl : ''}`;
      case 'file': return `<div class="fld"><div class="lb">${lbl}</div><button type="button" class="drop"${bad ? ' style="border-color:var(--danger)"' : ''}>${I('upload', 28)}<b>${esc(f.ph || 'แตะเพื่อเลือกไฟล์')}</b><span class="xs">${esc(f.h || '')}</span></button>${f.v ? `<div class="ctxc" style="margin:8px 0 0">${I('file')}<div class="t"><b>${esc(f.v)}</b><small>${esc(f.vs || 'พร้อมอัปโหลด')}</small></div><button type="button" class="ib" aria-label="เอาไฟล์ออก">${I('close', 18)}</button></div>` : ''}${errEl}</div>`;
      case 'static': return `<div class="fld"><div class="lb">${lbl}</div><div>${f.html || esc(f.v)}</div></div>`;
      case 'pw': c = `<input class="in" type="password"${aria} value="${esc(f.v || '')}" autocomplete="${f.ac || 'new-password'}" placeholder="${esc(f.ph || '')}">`; if (f.meter) c += `<div class="pw" aria-hidden="true">${J([0, 1, 2, 3], (i) => `<i class="${i < f.meter ? 'on' : ''}"></i>`)}</div><ul class="ul xs" style="margin:2px 0">${J(f.rules || ['อย่างน้อย 8 ตัวอักษร', 'มีตัวเลข', 'มีตัวพิมพ์ใหญ่'], (x, i) => `<li class="${i < f.meter ? 'ok' : 'mut'}">${I(i < f.meter ? 'check' : 'info', 14)}${esc(x)}</li>`)}</ul>`; break;
      default: c = `<input class="in" type="${f.t || 'text'}"${aria} value="${esc(f.v || '')}" placeholder="${esc(f.ph || '')}"${f.t === 'email' ? ' autocomplete="email" inputmode="email"' : ''}${f.t === 'number' ? ' inputmode="decimal"' : ''}>`;
    }
    if (inline && !['textarea', 'pw'].includes(f.t)) return `<label class="frow${bad ? ' bad' : ''}" for="${id}"><span class="lb">${lbl}</span>${c}</label>${errEl}`;
    return `<div class="fld"><label for="${id}">${lbl}</label>${c}${errEl}${hint}</div>`;
  }
  const fields = (fs, s, inline) => J(fs, (f) => (f.g && !inline ? '' : '') + field(f, s, inline));
  const curStep = (d) => { const m = /^step(\d)/.exec(d._s || ''); return m ? +m[1] - 1 : d.cur || 0; };
  function stepsForm(d, v, s) {
    const cur = curStep(d), n = d.steps.length;
    const ind = v === 'B' ? '' : v === 'C' ? `<div class="pad" style="padding-bottom:0"><div class="xs mut">ขั้น ${cur + 1} จาก ${n}</div><div class="prog"><i style="width:${((cur + 1) / n) * 100}%"></i></div></div>` : `<div class="steps" aria-label="ขั้น ${cur + 1} จาก ${n}">${J(d.steps, (x, i) => `<i class="${i <= cur ? 'on' : ''}"></i>`)}<span>${cur + 1}/${n}</span></div>`;
    if (v === 'B') return J(d.steps, (st, i) => `<section class="card" style="margin:8px 16px;${i !== cur ? 'opacity:.85' : ''}"><div class="top"><span class="pill ${i < cur ? 't-ok' : i === cur ? 't-info' : 't-mute'}">${i < cur ? '✓ ' : ''}ขั้น ${i + 1}</span><b>${esc(st.h)}</b></div>${i === cur ? `<p class="mut sm" style="margin:0 0 10px">${esc(st.p || '')}</p>${fields(st.fields, s)}<div style="display:flex;gap:8px">${i ? `<button class="btn" data-st="step${i}">ย้อนกลับ</button>` : ''}<button class="btn p" style="flex:1" data-st="${i + 1 < n ? 'step' + (i + 2) : 'success'}">${i + 1 < n ? 'ถัดไป' : esc(d.submit || 'เสร็จสิ้น')}</button></div>` : i < cur ? `<div class="mut sm">${esc(st.sum || 'กรอกแล้ว')}</div>` : ''}</section>`);
    const st = d.steps[cur];
    return `${ind}<form class="pad" data-validate data-fgst="${cur + 1 < n ? 'step' + (cur + 2) : 'success'}" id="${FID}"><h2 style="margin:4px 0 4px;font-size:${v === 'C' ? 24 : 19}px">${esc(st.h)}</h2><p class="mut sm" style="margin:0 0 14px">${esc(st.p || '')}</p>${banner(d.banner)}${fields(st.fields, s, v === 'C' && st.inline)}</form>`;
  }

  /* ---------- KINDS ---------- */
  const K = {};

  K.list = {
    A: (d) => ({ body: srch(d.search) + chipsBar(d.filters) + (d.sum ? `<div class="hs-hint">${esc(d.sum)}</div>` : '') + listBody(d, 'A') }),
    B: (d) => ({ body: (d.filters ? seg(d.filters.slice(0, 4).map((x) => (Array.isArray(x) ? `${x[0]} ${x[1] ?? ''}` : x)), nid()) : '') + srch(d.search) + (d.cards ? `<div class="cards">${J(d.cards, (c) => `<div class="card ${c.tone || ''}"><div class="top">${I(c.i || 'info')}<b>${esc(c.h)}</b></div><div class="sm mut">${esc(c.p)}</div></div>`)}</div>` : '') + listBody(d, 'B') }),
    C: (d) => ({ body: heroB(d.hero) + qa(d.actions) + chipsBar(d.filters) + listBody(d, 'C') }),
  };

  K.dash = {
    A: (d) => ({ body: (d.hello ? `<div class="pad"><b style="font-size:17px">${esc(d.hello)}</b>${d.helloS ? `<div class="mut sm">${esc(d.helloS)}</div>` : ''}</div>` : '') + kpisA(d.kpis) + (d.chart ? `<div class="sec">${esc(d.chart.h || 'แนวโน้ม')}</div><div class="pad" style="background:var(--card)">${chart(d.chart)}</div>` : '') + J(d.lists, (g) => secH(g) + `<div class="grp">${J(g.items, itemA)}</div>`) }),
    B: (d) => ({ body: (d.hello ? `<div class="cards"><div class="card hl"><h3>${esc(d.hello)}</h3><div class="sm">${esc(d.helloS || '')}</div></div></div>` : '') + (d.kpis ? `<div class="cards" style="display:grid;grid-template-columns:1fr 1fr">${J(d.kpis, (x) => `<div class="card"><div class="mut xs">${esc(x[0])}</div><b style="font-size:26px">${esc(x[1])}</b>${x[2] ? `<div class="xs ${x[3] || 'up'}">${esc(x[2])}</div>` : ''}</div>`)}</div>` : '') + (d.chart ? `<div class="cards"><div class="card"><h3>${esc(d.chart.h || 'แนวโน้ม')}</h3>${chart(d.chart)}</div></div>` : '') + J(d.lists, (g) => secH(g) + `<div class="cards">${J(g.items, itemB)}</div>`) }),
    C: (d) => ({ body: heroB(d.hero || (d.hello ? { h: d.hello, p: d.helloS, acts: d.heroActs } : null)) + qa(d.actions) + kpisC(d.kpis) + J(d.lists, (g) => secH(g) + `<div class="grp">${J(g.items, (it, i) => itemC(it, i, d.check))}</div>`) + (d.chart ? `<details class="acc"><summary>${I('chart')}${esc(d.chart.h || 'แนวโน้ม')}${I('down')}</summary><div class="pad">${chart(d.chart)}</div></details>` : '') }),
  };

  function secContent(s, v) {
    if (s.items) return v === 'B' ? `<div style="margin:0 -14px">${J(s.items, itemA)}</div>` : J(s.items, itemA);
    if (s.check) return `<div class="${v === 'B' ? '' : 'pad'}">${J(s.check, (c) => `<label class="cl ${c[1] ? 'dn' : ''}"><input type="checkbox" class="chk"${c[1] ? ' checked' : ''}><span>${esc(c[0])}</span></label>`)}</div>`;
    if (s.tl) return `<div class="${v === 'B' ? '' : 'pad'}"><ul class="tl">${J(s.tl, (x) => `<li><b>${esc(x[0])}</b> ${esc(x[1])}<small>${esc(x[2] || '')}</small></li>`)}</ul></div>`;
    if (s.dl) return `<dl class="dl ${v === 'B' ? '' : 'pad'}" style="margin:0">${J(s.dl, (x) => `<dt>${esc(x[0])}</dt><dd>${x[2] ? x[1] : esc(x[1])}</dd>`)}</dl>`;
    if (s.chart) return `<div class="${v === 'B' ? '' : 'pad'}">${chart(s.chart)}</div>`;
    return `<div class="${v === 'B' ? '' : 'pad'} prose">${s.html || esc(s.text || '')}</div>`;
  }
  const propVal = (p) => (p[2] === 'st' ? pill(p[1]) : p[2] === 'av' ? `${av(p[1])} ${esc(p[1])}` : p[2] === 'tag' ? tag(p[1]) : esc(p[1]));
  K.detail = {
    A: (d) => {
      const tid = nid(); const secs = d.sections || [];
      return { body: `<div class="pad" style="background:var(--card)"><div class="k">${esc(d.key || '')}${d.type ? ' · ' + esc(d.type) : ''}</div><h2 style="margin:4px 0 8px;font-size:19px">${esc(d.h)}</h2><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${d.st ? `<button class="chip"${go(d.stGo || 'iss.status-menu')} aria-haspopup="menu">${dot(d.st)}${ST[d.st] || ''}${I('down', 16)}</button>` : ''}${d.tag ? tag(d.tag) : ''}</div></div>${d.props ? `<div class="pg">${J(d.props, (p) => `<button${go(p[3])}><small>${esc(p[0])}</small><span>${propVal(p)}</span></button>`)}</div>` : ''}${banner(d.banner)}${secs.length ? seg(secs.map((s) => s.h + (s.n != null ? ` (${s.n})` : '')), tid) + J(secs, (s, i) => `<div data-panel="${i}" data-for="${tid}"${i ? ' hidden' : ''}>${secContent(s, 'A')}</div>`) : ''}`, foot: d.comment ? composer(d.comment) : d.acts ? actsFoot(d.acts) : '' };
    },
    B: (d) => ({ body: `<div class="cards"><div class="card"><div class="top">${d.st ? pill(d.st) : ''}${d.tag ? tag(d.tag) : ''}<span class="k">${esc(d.key || '')}</span></div><h3 style="font-size:20px">${esc(d.h)}</h3>${d.lead ? `<div class="mut sm">${esc(d.lead)}</div>` : ''}</div>${banner(d.banner)}${d.props ? `<div class="card"><h3>ข้อมูล</h3><dl class="dl">${J(d.props, (p) => `<dt>${esc(p[0])}</dt><dd>${propVal(p)}${p[3] ? `<button class="lnk" style="margin-left:auto"${go(p[3])}>แก้ไข</button>` : ''}</dd>`)}</dl></div>` : ''}${J(d.sections, (s) => `<div class="card"><h3>${esc(s.h)}${s.n != null ? ` <span class="pill t-mute">${s.n}</span>` : ''}</h3>${secContent(s, 'B')}</div>`)}${d.acts ? `<div style="display:flex;flex-direction:column;gap:8px">${J(d.acts, (a) => `<button class="btn ${a.dz ? 'sd' : a.p ? 'p' : ''} w"${go(a.go)}>${a.i ? I(a.i, 18) : ''}${esc(a.l)}</button>`)}</div>` : ''}</div>`, foot: d.comment ? composer(d.comment) : '' }),
    C: (d) => {
      const secs = d.sections || [];
      const nx = d.next ? `<div class="nextbar"><button class="btn p"${go(d.next.go)}>${I(d.next.i || 'chev', 18)}${esc(d.next.l)}</button>${d.next2 ? `<button class="btn"${go(d.next2.go)}>${esc(d.next2.l)}</button>` : ''}</div>` : '';
      return { body: `${nx}<div class="pad" style="background:var(--card)"><div style="display:flex;gap:8px;align-items:center">${d.st ? pill(d.st) : ''}${d.tag ? tag(d.tag) : ''}<span class="k">${esc(d.key || '')}</span></div><h2 style="margin:6px 0 4px;font-size:21px">${esc(d.h)}</h2>${d.prog != null ? `<div class="xs mut">ความคืบหน้า ${d.prog}%</div><div class="prog"><i style="width:${d.prog}%"></i></div>` : ''}${d.props ? `<div class="chips nw" style="margin-top:8px">${J(d.props, (p) => `<button class="chip"${go(p[3])}><small>${esc(p[0])}</small> ${propVal(p)}</button>`)}</div>` : ''}</div>${banner(d.banner)}${J(secs, (s, i) => `<details class="acc"${i === 0 ? ' open' : ''}><summary>${esc(s.h)}${s.n != null ? `<span class="k">${s.n}</span>` : '<span class="k"></span>'}${I('down')}</summary>${secContent(s, 'C')}</details>`)}`, foot: d.comment ? composer(d.comment, true) : d.acts ? actsFoot(d.acts, true) : '' };
    },
  };
  function composer(ph, rich) {
    return `<form class="composer" data-validate data-ok="ส่งความคิดเห็นแล้ว">${rich ? `<button type="button" class="ib"${go('iss.attach')} aria-label="แนบไฟล์">${I('clip')}</button><button type="button" class="ib"${go('iss.mention')} aria-label="แท็กสมาชิก">${I('at')}</button>` : ''}<input class="in" data-req required aria-label="${esc(ph)}" placeholder="${esc(ph)}"><button class="ib" style="background:var(--primary);color:var(--on-primary)" aria-label="ส่ง">${I('send', 18)}</button></form>`;
  }
  const actsFoot = (a, c) => `<div class="sfoot" style="display:flex;gap:8px;padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border)">${J(a, (x) => `<button class="btn ${x.dz ? 'sd' : x.p ? 'p' : ''}" style="flex:${x.p ? 2 : 1}"${go(x.go)}>${esc(x.l)}</button>`)}</div>`;

  K.board = {
    A: (d) => { const tid = nid(); return { body: chipsBar(d.filters) + `<div class="seg sc" role="tablist" data-tabs="${tid}">${J(d.cols, (c, i) => `<button role="tab" data-tab="${i}" aria-selected="${i === 0}">${dot(c.st)} ${esc(c.n)} <span class="k">${c.cards.length}</span></button>`)}</div>` + J(d.cols, (c, i) => `<div data-panel="${i}" data-for="${tid}"${i ? ' hidden' : ''}>${c.cards.length ? `<div class="grp">${J(c.cards, (x) => `<div class="row" style="cursor:default"><span class="t"><b><span class="k">${esc(x.k)}</span> ${esc(x.t)}</b><small>${esc(x.due || '')}${x.sub ? ' · ' + esc(x.sub) : ''}</small></span>${x.av ? av(x.av) : ''}<button class="btn sm"${go('proj.board-move')} aria-label="ย้าย ${esc(x.k)}">ย้าย</button><button class="ib"${go('iss.detail')} aria-label="เปิด ${esc(x.k)}">${I('chev', 18)}</button></div>`)}</div>` : emptyB({ h: 'ไม่มีการ์ดในคอลัมน์นี้', i: 'board' })}</div>`) }; },
    B: (d) => ({ body: `<div class="hs-hint">${I('chev', 14)}ปัดซ้าย-ขวาเพื่อดูคอลัมน์ถัดไป · กดค้างการ์ดเพื่อย้าย</div><div class="cols" tabindex="0" aria-label="คอลัมน์บอร์ด เลื่อนแนวนอน">${J(d.cols, (c) => `<section class="col" aria-label="${esc(c.n)}"><h3>${dot(c.st)}${esc(c.n)}<span class="k">${c.cards.length}${c.wip ? ' / ' + c.wip : ''}</span></h3>${J(c.cards, (x) => `<button class="tc"${go('iss.detail')}><div class="ln"><span class="k">${esc(x.k)}</span><span class="sp"></span>${x.pr ? `<span class="pill t-${x.pr === 'สูง' ? 'bad' : 'mute'}">${esc(x.pr)}</span>` : ''}</div><b style="font-weight:500">${esc(x.t)}</b><div class="ln">${x.av ? av(x.av) : ''}<span>${esc(x.due || '')}</span><span class="sp"></span>${x.sub ? `${I('task', 14)}${esc(x.sub)}` : ''}</div></button>`)}<button class="btn g w"${go('iss.create')}>${I('plus', 18)}เพิ่มการ์ด</button></section>`)}</div>` }),
    C: (d) => ({ body: (d.hero ? heroB(d.hero) : '') + J(d.cols, (c, i) => `<details class="acc"${i < 2 ? ' open' : ''}><summary>${dot(c.st)}${esc(c.n)}<span class="k">${c.cards.length}</span>${I('down')}</summary>${J(c.cards, (x) => `<button class="row"${go('iss.detail')} style="border:0"><span class="t"><b>${esc(x.t)}</b><small>${esc(x.k)} · ${esc(x.due || '')}</small></span>${x.av ? av(x.av) : ''}</button>${c.next ? `<div class="nx"><button class="chip" data-toast="ย้าย ${esc(x.k)} ไป ${esc(c.next)} แล้ว">${I('chev', 16)}ไป ${esc(c.next)}</button><button class="chip"${go('proj.board-move')}>สถานะอื่น…</button></div>` : ''}`)}</details>`) }),
  };

  const cell = (v) => (typeof v === 'string' && v.startsWith('st:') ? pill(v.slice(3)) : esc(v));
  K.table = {
    A: (d) => ({ body: chipsBar(d.filters) + `<div class="hs-hint">${I('chev', 14)}เลื่อนตารางแนวนอนได้ · คอลัมน์แรกตรึงไว้</div><div class="hs" tabindex="0" role="region" aria-label="${esc(d.cap || 'ตาราง')} เลื่อนแนวนอน"><table class="tb"><thead><tr>${d.sel ? '<th><span class="sr">เลือก</span></th>' : ''}${J(d.cols, (c) => `<th scope="col">${esc(c)}</th>`)}</tr></thead><tbody>${J(d.rows, (r) => `<tr>${d.sel ? `<td><input type="checkbox" class="chk"${go(d.selGo)} aria-label="เลือก ${esc(r[0])}"></td>` : ''}${J(r, (c, i) => (i === 0 ? `<th scope="row" style="position:sticky;left:0;background:var(--card);font-weight:500"><a class="lnk" style="min-height:0;padding:0" href="#"${go(d.go)}>${esc(c)}</a></th>` : `<td>${cell(c)}</td>`))}</tr>`)}</tbody></table></div>${d.tot ? `<div class="hs-hint">${esc(d.tot)}</div>` : ''}` }),
    B: (d) => ({ body: srch(d.search || 'ค้นหาในตาราง') + `<div class="cards">${J(d.rows, (r) => `<button class="card"${go(d.go)}><h3>${esc(r[0])}</h3><dl class="dl" style="grid-template-columns:40% 1fr">${J(r.slice(1), (c, i) => `<dt>${esc(d.cols[i + 1])}</dt><dd>${cell(c)}</dd>`)}</dl></button>`)}</div>` }),
    C: (d) => ({ body: `<div class="pad" style="padding-bottom:0"><div class="xs mut">แสดงคอลัมน์หลัก</div></div><div class="chips nw" style="padding:6px 16px" data-single>${J(d.cols.slice(1), (c, i) => `<button class="chip" data-chip aria-pressed="${i === (d.pri || 0)}">${esc(c)}</button>`)}<button class="chip"${go(d.colGo || 'proj.structure')}>${I('gear', 16)}คอลัมน์</button></div>${J(d.rows, (r) => `<details class="acc"><summary><span style="flex:1;min-width:0;font-weight:500">${esc(r[0])}</span><span>${cell(r[(d.pri || 0) + 1])}</span>${I('down')}</summary><dl class="dl pad" style="margin:0;padding-top:0">${J(r.slice(1), (c, i) => `<dt>${esc(d.cols[i + 1])}</dt><dd>${cell(c)}</dd>`)}</dl>${d.go ? `<div class="pad" style="padding-top:0"><button class="btn w"${go(d.go)}>เปิดรายละเอียด</button></div>` : ''}</details>`)}` }),
  };

  K.timeline = {
    A: (d) => {
      const cw = d.cw || 40, n = d.cols.length;
      return { body: chipsBar(d.zoom || ['สัปดาห์', 'เดือน', 'ไตรมาส']) + `<div class="hs-hint">${I('chev', 14)}เลื่อนแนวนอนในกรอบนี้ · ชื่องานตรึงซ้าย</div><div class="hs" tabindex="0" role="region" aria-label="แผนงาน เลื่อนแนวนอน"><div class="gt" style="grid-template-columns:120px repeat(${n},${cw}px)"><div class="gn gh" style="justify-content:flex-start">งาน</div>${J(d.cols, (c, i) => `<div class="gh${i === d.today ? ' today' : ''}">${esc(c)}</div>`)}${J(d.rows, (r) => `<a class="gn" href="#"${go(r.go || 'iss.detail')} style="text-decoration:none;color:inherit">${dot(r.st)}${esc(r.n)}</a><div class="gc" style="grid-column:span ${n}">${d.today != null ? `<i class="todayline" style="left:${d.today * cw + cw / 2}px"></i>` : ''}${r.ms ? `<i class="ms" style="left:${r.s * cw + cw / 2 - 8}px" title="${esc(r.n)}"></i>` : `<span class="gbar st-${r.st}" style="left:${r.s * cw + 2}px;width:${r.l * cw - 4}px">${esc(r.who || '')}</span>`}</div>`)}</div></div>${d.legend ? `<div class="pad leg">${J(d.legend, (l) => `<span>${dot(l[0])} ${esc(l[1])}</span>`)}</div>` : ''}` };
    },
    B: (d) => { const n = d.cols.length; return { body: J(d.groupsB || [{ h: d.rangeH || 'ช่วงนี้', rows: d.rows }], (g) => `<div class="sec">${esc(g.h)}</div><div class="cards">${J(g.rows, (r) => `<button class="card"${go(r.go || (r.ms ? 'proj.milestone' : 'iss.detail'))}><div class="top">${r.ms ? `<span class="pill t-info">${I('flag', 14)}Milestone</span>` : pill(r.st)}<span class="k" style="margin-left:auto">${esc(d.cols[r.s])}${r.l > 1 ? ' – ' + esc(d.cols[Math.min(n - 1, r.s + r.l - 1)]) : ''}</span></div><h3>${esc(r.n)}</h3>${r.ms ? '' : `<div class="bar-h" aria-hidden="true" style="position:relative;background:var(--subtle)"><i style="margin-left:${(r.s / n) * 100}%;width:${(r.l / n) * 100}%"></i></div>`}<div class="bot">${r.who ? av(r.who) + esc(r.who) : ''}<span class="sp"></span>${r.l ? `${r.l} วันทำการ` : ''}</div></button>`)}</div>`) }; },
    C: (d) => { const t = d.today ?? 0; const act = d.rows.filter((r) => t >= r.s && t < r.s + (r.l || 1)); const late = d.rows.filter((r) => r.st === 'over'); return { body: `<div class="wk" data-single role="group" aria-label="เลือกวัน">${J(d.cols.slice(Math.max(0, t - 2), t + 5), (c, i) => { const idx = Math.max(0, t - 2) + i; return `<button data-chip aria-pressed="${idx === t}"><small>${esc(c.split(' ')[0])}</small>${esc(c.split(' ')[1] || c)}</button>`; })}</div>${late.length ? `<div class="banner bad">${I('alert')}<div class="t"><b>${late.length} งานเลยกำหนด</b> กระทบเส้นทางวิกฤต</div><button class="btn sm"${go('iss.due-request')}>ขอเลื่อน</button></div>` : ''}<div class="sec">กำลังดำเนินการวันนี้ <span class="pill t-mute">${act.length}</span></div><div class="grp">${J(act, (r) => `<div class="crow">${dot(r.st)}<button class="row"${go(r.ms ? 'proj.milestone' : 'iss.detail')}><span class="t"><b>${esc(r.n)}</b><small>${esc(r.who || '')} · เหลือ ${Math.max(0, r.s + (r.l || 1) - t)} วัน</small></span>${pill(r.st)}</button></div>`)}</div><div class="sec">ถัดไป</div><div class="grp">${J(d.rows.filter((r) => r.s > t).slice(0, 4), (r) => `<button class="row"${go(r.ms ? 'proj.milestone' : 'iss.detail')}>${r.ms ? I('flag', 18) : dot(r.st)}<span class="t"><b>${esc(r.n)}</b><small>เริ่ม ${esc(d.cols[r.s])}</small></span></button>`)}</div>` }; },
  };

  K.cal = {
    A: (d) => { const off = d.off || 0, days = d.days || 30, sel = d.today; const ev = d.ev || {}; const sl = ev[sel] || []; return { body: `<div class="pad" style="display:flex;align-items:center;gap:8px;padding-bottom:0"><button class="ib" aria-label="เดือนก่อน">${I('back')}</button><b style="flex:1;text-align:center">${esc(d.month)}</b><button class="ib" aria-label="เดือนถัดไป">${I('chev')}</button></div><div class="cal" role="group" data-single aria-label="${esc(d.month)}">${J(['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'], (w) => `<div class="wd">${w}</div>`)}${J(Array(off).fill(0), () => '<span></span>')}${J(Array(days).fill(0), (x, i) => { const n = i + 1, e = ev[n] || []; return `<button data-chip aria-pressed="${n === sel}" class="${n === d.today ? 'td' : ''}" aria-label="${n} ${esc(d.month)}${e.length ? ' มี ' + e.length + ' รายการ' : ''}">${n}<span class="ds">${J(e.slice(0, 3), (x) => `<i class="d-${x.st || 'prog'}"></i>`)}</span></button>`; })}</div><div class="sec">วันที่ ${sel} · ${sl.length} รายการ</div><div class="grp">${J(sl, (x) => itemA({ t: x.t, s: x.s || x.time, st: x.st, go: x.go || 'iss.detail' }))}</div>` }; },
    B: (d) => ({ body: `<div class="chips nw" style="padding:8px 16px">${J(['สัปดาห์นี้', 'สัปดาห์หน้า', 'ทั้งเดือน'], (l, i) => `<button class="chip" data-chip aria-pressed="${!i}">${l}</button>`)}</div>${J(Object.keys(d.ev || {}), (k) => `<div class="sec">${+k === d.today ? 'วันนี้ · ' : ''}${k} ${esc(d.month.split(' ')[0])}</div><div class="cards">${J(d.ev[k], (x) => `<button class="card"${go(x.go || 'iss.detail')}><div class="top">${pill(x.st || 'prog')}<span class="k" style="margin-left:auto">${esc(x.time || 'ทั้งวัน')}</span></div><h3>${esc(x.t)}</h3>${x.s ? `<div class="mut sm">${esc(x.s)}</div>` : ''}</button>`)}</div>`)}` }),
    C: (d) => { const t = d.today, e = (d.ev || {})[t] || []; return { body: `<div class="wk" data-single>${J([-2, -1, 0, 1, 2, 3, 4], (o) => `<button data-chip aria-pressed="${!o}"><small>${['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'][(((t + o + (d.off || 0) - 1) % 7) + 7) % 7]}</small>${t + o}</button>`)}</div><div class="hrs" aria-label="ตารางเวลาวันนี้">${J([9, 10, 11, 12, 13, 14, 15, 16, 17], (h) => `<div class="h"><span>${h}:00</span></div>`)}${J(e.filter((x) => x.h != null), (x) => `<button class="ev"${go(x.go || 'iss.detail')} style="top:${(x.h - 9) * 56 + 2}px;height:${(x.dur || 1) * 56 - 4}px">${esc(x.t)}<br><small>${esc(x.time || '')}</small></button>`)}</div>${e.filter((x) => x.h == null).length ? `<div class="sec">ทั้งวัน / กำหนดส่ง</div><div class="grp">${J(e.filter((x) => x.h == null), (x) => itemA({ t: x.t, st: x.st, s: x.s, go: 'iss.detail' }))}</div>` : ''}` }; },
  };

  function srow(r, v) {
    const tail = r.t === 'tog' ? `<input type="checkbox" class="sw" role="switch" aria-label="${esc(r.l)}"${r.v ? ' checked' : ''}>` : r.t === 'btn' ? `<span class="btn sm">${esc(r.v)}</span>` : `${r.v != null ? `<span class="v">${r.v && r.v.st ? pill(r.v.st, r.v.l) : esc(r.v)}</span>` : ''}${r.go ? I('chev', 18) : ''}`;
    const tagN = r.t === 'tog' ? 'label' : r.go ? 'button' : 'div';
    return `<${tagN} class="sr-row${r.t === 'dz' ? ' dz' : ''}${r.hl && v === 'C' ? ' hl' : ''}"${go(r.go)}>${r.i ? I(r.i) : ''}<span class="t">${esc(r.l)}${r.d && v !== 'A' ? `<small>${esc(r.d)}</small>` : ''}</span>${tail}</${tagN}>`;
  }
  K.settings = {
    A: (d) => ({ body: (d.head ? d.head : '') + banner(d.banner) + J(d.groups, (g) => `${g.h ? `<div class="sec">${esc(g.h)}</div>` : ''}<div class="grp">${J(g.rows, (r) => srow(r, 'A'))}</div>`) + (d.save ? '' : ''), foot: d.save ? `<div class="sfoot" style="padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border)"><button class="btn p w" data-toast="บันทึกการตั้งค่าแล้ว">${esc(d.save)}</button></div>` : '' }),
    B: (d) => ({ body: (d.headB || d.head || '') + banner(d.banner) + J(d.groups, (g) => `${g.h ? `<div class="sec">${esc(g.h)}</div>` : ''}${g.p ? `<div class="pad mut sm" style="padding-top:0">${esc(g.p)}</div>` : ''}<div class="sg">${J(g.rows, (r) => srow(r, 'B'))}</div>`), foot: d.save ? `<div class="sfoot" style="padding:10px 16px calc(10px + var(--sab))"><button class="btn p w" data-toast="บันทึกการตั้งค่าแล้ว">${esc(d.save)}</button></div>` : '' }),
    C: (d) => { const hl = d.groups.flatMap((g) => g.rows.filter((r) => r.hl)); return { body: srch('ค้นหาการตั้งค่า') + banner(d.banner) + (hl.length ? `<div class="sec">${I('sparkle', 14)}แนะนำให้ดำเนินการ</div><div class="sg">${J(hl, (r) => srow(r, 'C'))}</div>` : '') + J(d.groups, (g, i) => `<details class="acc"${i === 0 && !hl.length ? ' open' : ''}><summary>${esc(g.h || 'ทั่วไป')}<span class="k">${g.rows.length}</span>${I('down')}</summary>${J(g.rows, (r) => srow(r, 'C'))}</details>`), foot: d.save ? `<div class="sfoot" style="padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border);display:flex;gap:8px"><button class="btn" data-st="default">ยกเลิก</button><button class="btn p" style="flex:1" data-toast="บันทึกการตั้งค่าแล้ว">${esc(d.save)}</button></div>` : '' }; },
  };

  const artBody = (d) => J(d.body, (b) => (Array.isArray(b) ? `<h2 id="${esc(b[2] || '')}">${esc(b[0])}</h2><p>${b[1]}</p>` : `<p>${b}</p>`)) + (d.steps ? `<ol>${J(d.steps, (s) => `<li>${esc(s)}</li>`)}</ol>` : '');
  const rel = (d) => (d.related ? `<div class="sec">บทความที่เกี่ยวข้อง</div><div class="grp">${J(d.related, (r) => itemA({ t: r[0], s: r[1], i: 'file', go: r[2] }))}</div>` : '');
  const helpful = `<div class="pad" style="text-align:center"><div class="mut sm">บทความนี้มีประโยชน์ไหม</div><div class="chips" data-single style="justify-content:center;margin-top:6px"><button class="chip" data-chip aria-pressed="false" data-toast="ขอบคุณสำหรับความเห็น">มีประโยชน์</button><button class="chip" data-chip aria-pressed="false" data-toast="ขอบคุณ เราจะปรับปรุงบทความ">ยังไม่ช่วย</button></div></div>`;
  K.article = {
    A: (d) => ({ body: `<article class="pad"><div class="xs mut">${esc(d.meta || '')}</div><h1 style="font-size:22px;margin:4px 0 10px">${esc(d.h)}</h1>${d.toc ? `<details class="acc" style="border:1px solid var(--border);border-radius:12px;margin-bottom:12px"><summary>${I('list')}สารบัญ<span class="k">${d.toc.length}</span>${I('down')}</summary>${J(d.toc, (t) => `<a class="mi" href="#">${esc(t)}</a>`)}</details>` : ''}<div class="prose">${artBody(d)}</div></article>${helpful}${rel(d)}` }),
    B: (d) => ({ body: `<div class="cards"><div class="card hl"><div class="ill" style="margin-bottom:10px">${I(d.i || 'file', 28)}</div><h3 style="font-size:21px">${esc(d.h)}</h3><div class="sm mut">${esc(d.meta || '')}</div></div><div class="card prose">${artBody(d)}</div></div>${helpful}${d.related ? `<div class="sec">อ่านต่อ</div><div class="cards">${J(d.related, (r) => itemB({ t: r[0], s: r[1], go: r[2] }))}</div>` : ''}` }),
    C: (d) => ({ body: `<div class="pad"><h1 style="font-size:20px;margin:0 0 8px">${esc(d.h)}</h1>${d.tldr ? `<div class="banner info" style="margin:0 0 12px">${I('sparkle')}<div class="t"><b>สรุปสั้น</b><br>${esc(d.tldr)}</div></div>` : ''}${d.steps ? `<ol class="prose" style="padding-left:0;list-style:none">${J(d.steps, (s, i) => `<li class="cl" style="align-items:flex-start"><span class="pill t-info">${i + 1}</span><span>${esc(s)}</span></li>`)}</ol>` : ''}</div><details class="acc"><summary>${I('file')}อ่านรายละเอียดทั้งหมด${I('down')}</summary><div class="pad prose">${artBody({ ...d, steps: null })}</div></details>${helpful}<div class="cards"><div class="card"><h3>ยังติดปัญหาอยู่ไหม</h3><div class="sm mut">ทีมช่วยเหลือตอบภายในวันทำการ</div><div style="display:flex;gap:8px;margin-top:10px"><button class="btn p" style="flex:1"${go(d.contact || 'help.contact')}>ติดต่อทีม</button><button class="btn"${go(d.back2 || 'help.center')}>กลับ</button></div></div></div>` }),
  };

  K.market = {
    A: (d) => ({ body: `${d.hero ? `<section class="pad" style="padding-top:24px"><div class="brand" style="margin-bottom:16px"><span class="logo"><i></i><i></i><i></i><i></i></span>Friday</div><h1 style="font-size:26px;margin:0 0 8px;line-height:1.3">${esc(d.hero.h)}</h1><p class="mut" style="margin:0 0 16px">${esc(d.hero.p)}</p><div style="display:flex;gap:8px"><button class="btn p" style="flex:1"${go(d.hero.go || 'auth.signup')}>${esc(d.hero.cta)}</button>${d.hero.cta2 ? `<button class="btn"${go(d.hero.go2)}>${esc(d.hero.cta2)}</button>` : ''}</div></section>` : ''}${d.toggle ? chipsBar(d.toggle, '') : ''}${d.feats ? `<div class="sec">ฟีเจอร์</div><div class="grp">${J(d.feats, (f) => itemA({ i: f[0], t: f[1], s: f[2] }))}</div>` : ''}${d.plans ? `<div class="sec">แผน</div><div class="grp">${J(d.plans, (p) => `<button class="row"${go(p.go || 'auth.signup')}><span class="t"><b>${esc(p.n)} ${p.hl ? '<span class="pill t-info">แนะนำ</span>' : ''}</b><small>${esc(p.f.slice(0, 2).join(' · '))}</small></span><span class="m"><b style="font-size:16px;color:var(--foreground)">${esc(p.p)}</b><span>${esc(p.per || '')}</span></span></button>`)}</div>${d.cmp ? `<div class="hs" tabindex="0" role="region" aria-label="ตารางเทียบแผน"><table class="tb"><thead><tr>${J(d.cmp[0], (c) => `<th>${esc(c)}</th>`)}</tr></thead><tbody>${J(d.cmp.slice(1), (r) => `<tr>${J(r, (c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row" style="position:sticky;left:0;background:var(--card)">${esc(c)}</th>`))}</tr>`)}</tbody></table></div>` : ''}` : ''}${d.faq ? `<div class="sec">คำถามที่พบบ่อย</div>${J(d.faq, (q) => `<details class="acc"><summary>${esc(q[0])}${I('down')}</summary><div class="pad prose" style="padding-top:0">${esc(q[1])}</div></details>`)}` : ''}<div class="pad xs mut" style="text-align:center">© 2569 Friday · <a class="lnk"${go('pub.legal')} href="#">ข้อกำหนด</a></div>` }),
    B: (d) => ({ body: `${d.hero ? `<section class="cards" style="padding-top:12px"><div class="card hl" style="padding:22px 18px;text-align:center"><span class="logo l" style="margin:0 auto 14px"><i></i><i></i><i></i><i></i></span><h1 style="font-size:24px;margin:0 0 8px">${esc(d.hero.h)}</h1><p class="mut sm" style="margin:0 0 16px">${esc(d.hero.p)}</p><button class="btn p w"${go(d.hero.go || 'auth.signup')}>${esc(d.hero.cta)}</button>${d.hero.cta2 ? `<button class="btn g w"${go(d.hero.go2)}>${esc(d.hero.cta2)}</button>` : ''}</div></section>` : ''}${d.feats ? `<div class="cards" style="display:grid;grid-template-columns:1fr 1fr">${J(d.feats, (f) => `<div class="card"><div class="ill" style="width:40px;height:40px;border-radius:12px;margin-bottom:8px">${I(f[0])}</div><b>${esc(f[1])}</b><div class="xs mut">${esc(f[2])}</div></div>`)}</div>` : ''}${d.toggle ? seg(d.toggle, nid()) : ''}${d.plans ? `<div class="cols" tabindex="0" aria-label="แผน เลื่อนแนวนอน">${J(d.plans, (p) => `<div class="card pricec ${p.hl ? 'hl' : ''}"><div class="top"><b style="font-size:18px">${esc(p.n)}</b>${p.hl ? '<span class="pill t-info">แนะนำ</span>' : ''}</div><div class="price"><b>${esc(p.p)}</b> <span class="mut sm">${esc(p.per || '')}</span></div><ul class="ul">${J(p.f, (x) => `<li>${I('check', 16)}${esc(x)}</li>`)}</ul><button class="btn ${p.hl ? 'p' : ''} w"${go(p.go || 'auth.signup')}>${esc(p.cta || 'เลือกแผนนี้')}</button></div>`)}</div>` : ''}${d.faq ? `<div class="sec">คำถามที่พบบ่อย</div><div class="cards">${J(d.faq, (q) => `<div class="card"><h3>${esc(q[0])}</h3><div class="sm mut">${esc(q[1])}</div></div>`)}</div>` : ''}` }),
    C: (d) => ({ body: `${d.hero ? `<section class="auth-c" style="padding-bottom:28px"><div class="brand"><span class="logo"><i></i><i></i><i></i><i></i></span>Friday</div><h1 style="font-size:24px;margin:18px 0 6px">${esc(d.hero.h)}</h1><p>${esc(d.hero.p)}</p><form data-validate data-fgo="auth.signup" style="display:flex;gap:8px;margin-top:16px"><input class="in" type="email" data-req required placeholder="อีเมลที่ทำงาน" aria-label="อีเมลที่ทำงาน" style="flex:1"><button class="btn p">เริ่มฟรี</button></form><div class="err" hidden></div></section>` : ''}${d.toggle ? seg(d.toggle, nid()) : ''}${d.plans ? J(d.plans, (p) => `<details class="acc"${p.hl ? ' open' : ''}><summary><span style="flex:1">${esc(p.n)} ${p.hl ? '<span class="pill t-info">แนะนำ</span>' : ''}</span><b>${esc(p.p)}</b>${I('down')}</summary><div class="pad" style="padding-top:0"><ul class="ul">${J(p.f, (x) => `<li>${I('check', 16)}${esc(x)}</li>`)}</ul><button class="btn ${p.hl ? 'p' : ''} w"${go(p.go || 'auth.signup')}>${esc(p.cta || 'เลือก ' + p.n)}</button></div></details>`) : ''}${d.feats ? `<div class="sec">ทำอะไรได้บ้าง</div><div class="qa" style="grid-template-columns:1fr 1fr">${J(d.feats, (f) => `<button>${I(f[0], 22)}<span>${esc(f[1])}</span></button>`)}</div>` : ''}${d.faq ? J(d.faq, (q) => `<details class="acc"><summary>${esc(q[0])}${I('down')}</summary><div class="pad prose" style="padding-top:0">${esc(q[1])}</div></details>`) : ''}`, foot: `<div class="sfoot" style="display:flex;gap:8px;padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border)"><button class="btn" style="flex:1"${go('auth.login')}>เข้าสู่ระบบ</button><button class="btn p" style="flex:2"${go('auth.signup')}>ทดลองใช้ฟรี 14 วัน</button></div>` }),
  };

  K.thread = {
    A: (d) => ({ body: `${d.props ? `<div class="pg">${J(d.props, (p) => `<div><small>${esc(p[0])}</small><span>${propVal(p)}</span></div>`)}</div>` : ''}${banner(d.banner)}<div class="msgs">${J(d.msgs, (m) => `<div class="msg ${m.me ? 'me' : ''}">${m.who && !m.me ? `<b class="xs">${esc(m.who)}</b><br>` : ''}${esc(m.t)}<small>${esc(m.when)}</small></div>`)}</div>`, foot: composer(d.composer || 'พิมพ์ข้อความ…') }),
    B: (d) => ({ body: `<div class="cards">${d.props ? `<div class="card"><dl class="dl">${J(d.props, (p) => `<dt>${esc(p[0])}</dt><dd>${propVal(p)}</dd>`)}</dl></div>` : ''}${banner(d.banner)}${J(d.msgs, (m) => `<div class="card"><div class="top">${av(m.who || 'ฉัน')}<b>${esc(m.me ? 'คุณ' : m.who)}</b><span class="k" style="margin-left:auto">${esc(m.when)}</span></div><div class="prose" style="font-size:14.5px">${esc(m.t)}</div></div>`)}</div>`, foot: composer(d.composer || 'ตอบกลับ…') }),
    C: (d) => ({ body: `${d.props ? `<div class="pad" style="background:var(--card);display:flex;gap:6px;flex-wrap:wrap">${J(d.props, (p) => `<span class="chip" style="min-height:32px"><small>${esc(p[0])}</small> ${propVal(p)}</span>`)}</div>` : ''}${banner(d.banner)}${d.nextAct ? `<div class="nextbar"><button class="btn p"${go(d.nextAct.go)} ${d.nextAct.toast ? `data-toast="${esc(d.nextAct.toast)}"` : ''}>${esc(d.nextAct.l)}</button></div>` : ''}<div class="msgs">${J(d.msgs, (m) => `<div class="msg ${m.me ? 'me' : ''}">${m.who && !m.me ? `<b class="xs">${esc(m.who)}</b><br>` : ''}${esc(m.t)}<small>${esc(m.when)}</small></div>`)}</div>${d.quick ? `<div class="chips nw" style="padding:4px 16px 10px">${J(d.quick, (q) => `<button class="chip" data-toast="แทรกข้อความ: ${esc(q)}">${esc(q)}</button>`)}</div>` : ''}`, foot: composer(d.composer || 'พิมพ์ข้อความ…', true) }),
  };

  K.state = {
    A: (d) => ({ body: `<div class="pad" style="padding-top:40px"><div class="ill ${d.tone || ''}">${I(d.i || 'alert', 30)}</div>${d.code ? `<div class="k" style="margin-top:16px">${esc(d.code)}</div>` : ''}<h1 style="font-size:22px;margin:6px 0">${esc(d.h)}</h1><p class="mut">${esc(d.p)}</p><div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">${J(d.acts, (a, i) => `<button class="btn ${i ? '' : 'p'} w"${a.go ? go(a.go) : ` data-st="${a.st || 'default'}"`}>${esc(a.l)}</button>`)}</div></div>` }),
    B: (d) => ({ body: `<div class="empty" style="padding-top:72px"><div class="ill ${d.tone || ''}" style="width:96px;height:96px;border-radius:30px">${I(d.i || 'alert', 44)}</div>${d.code ? `<div class="pill t-mute">${esc(d.code)}</div>` : ''}<h3 style="font-size:21px">${esc(d.h)}</h3><p>${esc(d.p)}</p>${J(d.acts, (a, i) => `<button class="btn ${i ? 'g' : 'p'}"${a.go ? go(a.go) : ` data-st="${a.st || 'default'}"`}>${esc(a.l)}</button>`)}</div>` }),
    C: (d) => ({ body: `<div class="banner ${d.tone === 'ok' ? 'ok' : d.tone === 'warn' ? 'warn' : 'bad'}" style="margin-top:16px">${I(d.i || 'alert')}<div class="t"><b>${esc(d.h)}</b><br>${esc(d.p)}</div></div><div class="sec">ทำต่อได้ทันที</div><div class="grp">${J(d.acts, (a) => `<button class="mi"${a.go ? go(a.go) : ` data-st="${a.st || 'default'}"`}>${I(a.i || 'chev')}<span class="t">${esc(a.l)}${a.s ? `<small>${esc(a.s)}</small>` : ''}</span>${I('chev', 16)}</button>`)}</div>${d.code ? `<div class="pad xs mut">รหัสอ้างอิง ${esc(d.code)}</div>` : ''}` }),
  };

  /* ฟอร์มเต็มหน้า */
  function formSubmitFoot(d, s, v) {
    const busy = s === 'loading';
    const lbl = busy ? 'กำลังดำเนินการ…' : d.submit || 'บันทึก';
    return `<div class="sfoot" style="display:flex;gap:8px;padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border)">${d.cancel !== false && v !== 'A' ? `<button class="btn" data-back>${esc(d.cancel || 'ยกเลิก')}</button>` : ''}<button class="btn p${busy ? ' busy' : ''}" style="flex:1" form="${FID}"${busy ? ' disabled aria-busy="true"' : ''}>${esc(lbl)}</button></div>`;
  }
  const doneP = (d) => `<div class="empty" style="padding-top:56px"><div class="ill ok">${I('check', 32)}</div><h3>${esc(d.done.h)}</h3><p>${esc(d.done.p || '')}</p>${d.done.html || ''}${d.done.cta ? `<button class="btn p"${go(d.done.go)}>${esc(d.done.cta)}</button>` : ''}</div>`;
  K.form = {
    A: (d, r, s) => { if (s === 'success' && d.done) return { body: doneP(d) }; if (d.steps) return { body: stepsForm(d, 'A', s), foot: stepFoot(d, s) }; return { body: `<form class="pad" id="${FID}" data-validate data-ok="${esc(d.okMsg || 'บันทึกแล้ว')}"${d.okGo ? ` data-fgo="${d.okGo}"` : ''}>${d.intro ? `<p class="mut sm" style="margin:0 0 12px">${esc(d.intro)}</p>` : ''}${banner(d.banner)}${s === 'error' && d.errB ? banner(['bad', d.errB]) : ''}${d.html || ''}${fields(d.fields, s)}</form>`, foot: formSubmitFoot(d, s, 'A') }; },
    B: (d, r, s) => { if (s === 'success' && d.done) return { body: doneP(d) }; if (d.steps) return { body: stepsForm(d, 'B', s) }; const gs = []; (d.fields || []).forEach((f) => { const g = f.g || 'ข้อมูล'; let x = gs.find((y) => y.h === g); if (!x) gs.push((x = { h: g, f: [] })); x.f.push(f); }); return { body: `<form id="${FID}" data-validate data-ok="${esc(d.okMsg || 'บันทึกแล้ว')}"${d.okGo ? ` data-fgo="${d.okGo}"` : ''}>${d.intro ? `<div class="pad mut sm">${esc(d.intro)}</div>` : ''}${banner(d.banner)}${s === 'error' && d.errB ? banner(['bad', d.errB]) : ''}${d.html ? `<div class="cards">${d.html}</div>` : ''}${J(gs, (g) => `<div class="sec">${esc(g.h)}</div><div class="cards"><div class="card">${fields(g.f, s)}</div></div>`)}</form>`, foot: formSubmitFoot(d, s, 'B') }; },
    C: (d, r, s) => { if (s === 'success' && d.done) return { body: doneP(d) }; if (d.steps) return { body: stepsForm(d, 'C', s), foot: stepFoot(d, s) }; return { body: `${d.ctxc ? `<div class="pad"><div class="ctxc" style="margin:0">${I(d.ctxc.i || 'info')}<div class="t"><b>${esc(d.ctxc.t)}</b><small>${esc(d.ctxc.s || '')}</small></div></div></div>` : ''}${banner(d.banner)}${s === 'error' && d.errB ? banner(['bad', d.errB]) : ''}<form class="pad" id="${FID}" data-validate data-ok="${esc(d.okMsg || 'บันทึกแล้ว')}"${d.okGo ? ` data-fgo="${d.okGo}"` : ''} style="background:var(--card)">${d.html || ''}${fields(d.fields, s, true)}</form>`, foot: formSubmitFoot(d, s, 'C') }; },
  };
  function stepFoot(d, s) {
    const cur = curStep(d), n = d.steps.length;
    return `<div class="sfoot" style="display:flex;gap:8px;padding:10px 16px calc(10px + var(--sab));background:var(--card);border-top:1px solid var(--border)">${cur ? `<button class="btn" data-st="step${cur}">ย้อนกลับ</button>` : d.skip ? `<button class="btn g"${go(d.skip)}>ข้าม</button>` : ''}<button class="btn p" style="flex:1" form="${FID}">${cur + 1 < n ? 'ถัดไป' : esc(d.submit || 'เสร็จสิ้น')}</button></div>`;
  }

  /* auth */
  function authInner(d, s, v) {
    if (d.done && s === 'success') return `<div style="text-align:${v === 'A' ? 'left' : 'center'}"><div class="ill ok" style="${v === 'A' ? '' : 'margin:0 auto'}">${I('check', 30)}</div><h2 style="margin:14px 0 6px">${esc(d.done.h)}</h2><p class="mut">${esc(d.done.p || '')}</p>${d.done.cta ? `<button class="btn p w"${go(d.done.go)}>${esc(d.done.cta)}</button>` : ''}</div>`;
    const busy = s === 'loading';
    const dots = d.dots ? `<div class="steps" style="padding:0 0 12px;max-width:120px;${v === 'A' ? '' : 'margin:0 auto'}" role="img" aria-label="ขั้นที่ ${d.dots[0]} จาก ${d.dots[1]}">${J(Array(d.dots[1]).fill(0), (x, i) => `<i class="${i < d.dots[0] ? 'on' : ''}"></i>`)}</div>` : '';
    return `${dots}${d.ill ? `<div class="ill ${d.illT || ''}" style="${v === 'A' ? '' : 'margin:0 auto 4px'}">${I(d.ill, 28)}</div>` : ''}<h2 style="margin:10px 0 4px;font-size:22px">${esc(d.h)}</h2><p class="mut sm" style="margin:0 0 16px">${d.p || ''}</p>${banner(d.banner)}${s === 'error' && d.errB ? banner(['bad', d.errB]) : ''}${d.html || ''}${d.fields ? `<form data-validate${d.okGo ? ` data-fgo="${d.okGo}"` : ''}${d.okSt ? ` data-fgst="${d.okSt}"` : ''} id="${FID}" style="text-align:left">${fields(d.fields, s)}${d.submit ? `<button class="btn p w${busy ? ' busy' : ''}"${busy ? ' disabled aria-busy="true"' : ''}>${esc(busy ? 'กำลังดำเนินการ…' : d.submit)}</button>` : ''}</form>` : ''}${d.btns ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${J(d.btns, (b) => `<button class="btn ${b.p ? 'p' : ''} w"${go(b.go)}${b.st ? ` data-st="${b.st}"` : ''}>${b.i ? I(b.i, 18) : ''}${esc(b.l)}</button>`)}</div>` : ''}${d.oauth ? `<div class="xs mut" style="text-align:center;margin:14px 0 8px">หรือ</div><button class="btn w"${go('auth.login-mfa')}>${I('globe', 18)}ดำเนินการต่อด้วย Google</button>` : ''}<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:4px;margin-top:12px">${J(d.alt, (a) => `<button class="lnk"${go(a.go)}${a.st ? ` data-st="${a.st}"` : ''}>${esc(a.l)}</button>`)}</div>${d.note ? `<p class="xs mut" style="text-align:center">${esc(d.note)}</p>` : ''}`;
  }
  K.auth = {
    raw: true,
    A: (d, r, s) => ({ body: `<div class="pad" style="padding-top:20px">${d.back ? `<button class="ib" data-back aria-label="ย้อนกลับ" style="margin-left:-12px">${I('back')}</button>` : `<div class="brand" style="margin-bottom:18px"><span class="logo"><i></i><i></i><i></i><i></i></span>Friday</div>`}${authInner(d, s, 'A')}</div>` }),
    B: (d, r, s) => ({ body: `<div class="auth-b"><div style="text-align:center;margin-bottom:16px"><span class="logo l" style="margin:0 auto"><i></i><i></i><i></i><i></i></span></div><div class="card" style="text-align:center">${authInner(d, s, 'B')}</div><p class="xs mut" style="text-align:center">ข้อมูลทั้งหมดในต้นแบบเป็นข้อมูลสมมติ</p></div>` }),
    C: (d, r, s) => ({ body: `<div class="auth-c">${d.back ? `<button class="ib" data-back aria-label="ย้อนกลับ" style="color:var(--inverse-ink);margin-left:-12px">${I('back')}</button>` : ''}<div class="brand"><span class="logo"><i></i><i></i><i></i><i></i></span>Friday Manage</div><h1 style="font-size:24px;margin:16px 0 0">${esc(d.ch || d.h)}</h1><p>${esc(d.cp || 'จัดการงานทีมให้จบในที่เดียว')}</p></div><div class="auth-sheet">${authInner({ ...d, h: d.ch ? d.h : '' }, s, 'C')}</div>` }),
  };

  /* ---------- Overlays ---------- */
  const dlgAttrs = (id, cls) => `class="dlg ${cls}" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1"`;
  const xBtn = `<button class="ib" data-back aria-label="ปิด">${I('close')}</button>`;
  K.sheet = {
    ov: true,
    A: (d, r, s) => { const id = nid(); const busy = s === 'loading'; return `<div class="ov">${s === 'success' && !d.done ? '' : `<div ${dlgAttrs(id, 'full')}><div class="dh"><button class="btn g" data-back>ยกเลิก</button><h2 id="${id}">${esc(d.h || r.titleThai)}</h2>${s === 'success' ? '<span style="width:72px"></span>' : `<button class="btn g${busy ? ' busy' : ''}" form="${FID}"${busy ? ' disabled' : ''}>${esc(busy ? '' : d.submitShort || d.submit || 'บันทึก')}</button>`}</div><div class="sbody">${s === 'success' ? doneP(d) : sheetForm(d, s, false)}</div></div>`}</div>`; },
    B: (d, r, s) => { const id = nid(); return `<div class="ov">${s === 'success' && !d.done ? '' : `<div ${dlgAttrs(id, 'sheet')}><div class="grab" aria-hidden="true"></div><div class="dh"><h2 id="${id}">${esc(d.h || r.titleThai)}</h2>${xBtn}</div><div class="sbody">${s === 'success' ? doneP(d) : sheetForm(d, s, false)}</div>${s === 'success' ? `<div class="sfoot"><button class="btn p" data-back>เสร็จสิ้น</button></div>` : sheetFoot(d, s)}</div>`}</div>`; },
    C: (d, r, s) => { const id = nid(); const busy = s === 'loading'; return `<div class="ov">${s === 'success' && !d.done ? '' : `<div ${dlgAttrs(id, 'sheet')}><div class="dh" style="padding-top:10px"><h2 id="${id}">${esc(d.h || r.titleThai)}</h2>${xBtn}</div><div class="sbody" style="padding-top:4px">${s === 'success' ? doneP(d) : `${d.ctxc ? `<div class="ctxc">${I(d.ctxc.i || 'task')}<div class="t"><b>${esc(d.ctxc.t)}</b><small>${esc(d.ctxc.s || '')}</small></div></div>` : ''}${d.quick ? `<div class="chips nw" style="margin-bottom:10px">${J(d.quick, (q) => `<button type="button" class="chip" data-chip aria-pressed="false">${esc(q)}</button>`)}</div>` : ''}${sheetForm(d, s, true)}`}</div>${s === 'success' ? `<div class="sfoot"><button class="btn p" data-back>เสร็จสิ้น</button></div>` : `<div class="sfoot" style="flex-direction:column"><button class="btn p w${busy ? ' busy' : ''}" form="${FID}"${busy ? ' disabled aria-busy="true"' : ''}>${esc(busy ? 'กำลังดำเนินการ…' : d.submit || 'บันทึก')}</button>${d.alt2 ? `<button class="btn g w"${go(d.alt2.go)}>${esc(d.alt2.l)}</button>` : ''}</div>`}</div>`}</div>`; },
  };
  function sheetForm(d, s, inline) {
    return `<form id="${FID}" data-validate data-ok="${esc(d.okMsg || 'บันทึกแล้ว')}"${d.okGo ? ` data-fgo="${d.okGo}"` : ''}${d.done ? ' data-fgst="success"' : ' data-close'}>${d.intro ? `<p class="mut sm" style="margin:0 0 12px">${esc(d.intro)}</p>` : ''}${banner(d.banner)}${s === 'error' && d.errB ? banner(['bad', d.errB]) : ''}${d.html || ''}${fields(d.fields, s, inline)}${d.list ? `<div style="margin:0 -16px">${J(d.list, itemA)}</div>` : ''}${d.dz ? `<button type="button" class="btn sd w" style="margin-top:8px"${go(d.dz.go)}>${I('trash', 18)}${esc(d.dz.l)}</button>` : ''}</form>`;
  }
  function sheetFoot(d, s) { const busy = s === 'loading'; return `<div class="sfoot"><button class="btn" data-back>ยกเลิก</button><button class="btn p${busy ? ' busy' : ''}" form="${FID}"${busy ? ' disabled aria-busy="true"' : ''}>${esc(busy ? 'กำลังดำเนินการ…' : d.submit || 'บันทึก')}</button></div>`; }

  K.confirm = {
    ov: true,
    A: (d, r, s) => { if (s === 'success') return ''; const id = nid(); return `<div class="ov"><div ${dlgAttrs(id, 'alert')} role="alertdialog"><div class="sbody"><div class="ill ${d.tone === 'p' ? '' : 'bad'}">${I(d.ill || (d.tone === 'p' ? 'info' : 'trash'), 28)}</div><h2 id="${id}">${esc(d.h)}</h2><p class="mut sm" style="margin:0">${d.p || ''}</p>${s === 'error' ? banner(['bad', d.err || 'ทำรายการไม่สำเร็จ ลองอีกครั้ง']) : ''}${typeIn(d)}${d.fields ? `<div style="text-align:left;margin-top:12px">${fields(d.fields, s)}</div>` : ''}</div><div class="sfoot">${okBtn(d, s)}<button class="btn" data-back>${esc(d.cancel || 'ยกเลิก')}</button></div></div></div>`; },
    B: (d, r, s) => { if (s === 'success') return ''; const id = nid(); return `<div class="ov"><div ${dlgAttrs(id, 'sheet')} role="alertdialog"><div class="grab" aria-hidden="true"></div><div class="dh"><h2 id="${id}">${esc(d.h)}</h2>${xBtn}</div><div class="sbody" style="padding-top:0"><p class="mut" style="margin:0">${d.p || ''}</p>${d.impact ? `<ul class="impact">${J(d.impact, (x) => `<li>${I(x[1] || 'info', 18)}<span>${esc(x[0])}</span></li>`)}</ul>` : ''}${s === 'error' ? banner(['bad', d.err || 'ทำรายการไม่สำเร็จ ลองอีกครั้ง']) : ''}${typeIn(d)}${d.fields ? fields(d.fields, s) : ''}</div><div class="sfoot"><button class="btn" data-back>${esc(d.cancel || 'ยกเลิก')}</button>${okBtn(d, s)}</div></div></div>`; },
    C: (d, r, s) => { if (s === 'success') return ''; const id = nid(); return `<div class="ov"><div class="as" role="alertdialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1"><div class="grp2"><div class="cap"><b id="${id}">${esc(d.h)}</b>${d.p || ''}${d.undo ? `<div class="xs" style="margin-top:6px;color:var(--success-text)">${I('refresh', 14)} ${esc(d.undo)}</div>` : ''}</div>${s === 'error' ? `<div style="padding:0 12px">${banner(['bad', d.err || 'ทำรายการไม่สำเร็จ'])}</div>` : ''}${d.type || d.fields ? `<div style="padding:12px 16px;border-bottom:1px solid var(--border)">${typeIn(d)}${d.fields ? fields(d.fields, s) : ''}</div>` : ''}${d.alts ? J(d.alts, (a) => `<button class="mi"${go(a.go)}${a.toast ? ` data-toast="${esc(a.toast)}"` : ''}>${esc(a.l)}</button>`) : ''}<button class="mi ${d.tone === 'p' ? '' : 'dz'}${s === 'loading' ? ' busy' : ''}" style="font-weight:700${d.tone === 'p' ? ';color:var(--primary-text)' : ''}"${s === 'loading' ? ' disabled' : ''}${d.type ? ' data-needs aria-disabled="true"' : ''} data-gst="success">${esc(s === 'loading' ? 'กำลังดำเนินการ…' : d.ok)}</button></div><div class="grp2"><button class="mi" data-back style="font-weight:600">${esc(d.cancel || 'ยกเลิก')}</button></div></div></div>`; },
  };
  const typeIn = (d) => (d.type ? `<div class="fld" style="text-align:left;margin-top:12px"><label>พิมพ์ <b>${esc(d.type)}</b> เพื่อยืนยัน</label><input class="in" data-match="${esc(d.type)}" autocomplete="off" aria-label="พิมพ์ ${esc(d.type)} เพื่อยืนยัน"></div>` : '');
  const okBtn = (d, s) => `<button class="btn ${d.tone === 'p' ? 'p' : 'd'}${s === 'loading' ? ' busy' : ''}"${s === 'loading' ? ' disabled aria-busy="true"' : ''}${d.type ? ' data-needs disabled' : ''} data-gst="success">${esc(s === 'loading' ? 'กำลังดำเนินการ…' : d.ok)}</button>`;

  const mi = (x) => (x.sep ? `<div class="hr" role="separator"></div>${x.l ? `<div class="sec" style="padding-top:6px">${esc(x.l)}</div>` : ''}` : `<button class="mi${x.dz ? ' dz' : ''}" role="menuitem${x.on != null ? 'radio' : ''}"${x.on != null ? ` aria-checked="${!!x.on}"` : ''}${go(x.go)}${x.toast ? ` data-toast="${esc(x.toast)}"` : ''}${!x.go && !x.toast ? ' data-back' : ''}>${x.i ? I(x.i) : x.av ? av(x.av) : x.st ? dot(x.st) : ''}<span class="t">${esc(x.l)}${x.s ? `<small>${esc(x.s)}</small>` : ''}</span>${x.k ? `<span class="k">${esc(x.k)}</span>` : ''}</button>`);
  K.menu = {
    ov: true,
    A: (d, r) => { const id = nid(); return `<div class="ov" style="background:transparent" data-back-bg><div ${dlgAttrs(id, 'pop')} role="menu" aria-labelledby="${id}"><div class="sec" id="${id}" style="padding-top:8px">${esc(d.h || r.titleThai)}</div><div class="sbody">${J(d.items, mi)}</div></div></div>`; },
    B: (d, r) => { const id = nid(); return `<div class="ov" data-back-bg><div class="as" role="menu" aria-labelledby="${id}" tabindex="-1"><div class="grp2"><div class="cap"><b id="${id}">${esc(d.h || r.titleThai)}</b>${esc(d.sub || '')}</div>${J(d.items.filter((x) => !x.sep), mi)}</div><div class="grp2"><button class="mi" data-back style="font-weight:600">ยกเลิก</button></div></div></div>`; },
    C: (d, r) => { const id = nid(); return `<div class="ov"><div ${dlgAttrs(id, 'full')} role="menu"><div class="dh" style="justify-content:space-between"><button class="ib" data-back aria-label="ปิด">${I('close')}</button><h2 id="${id}">${esc(d.h || r.titleThai)}</h2><span style="width:44px"></span></div>${d.items.length > 5 ? `<label class="srch">${I('search')}<input type="search" placeholder="ค้นหา" aria-label="ค้นหาในเมนู" data-filter></label>` : ''}<div class="sbody" style="padding:0">${d.sub ? `<div class="pad mut sm">${esc(d.sub)}</div>` : ''}${J(d.items, mi)}</div></div></div>`; },
  };

  K.panel = {
    ov: true,
    A: (d, r, s) => { const id = nid(); return `<div class="ov" data-back-bg><div ${dlgAttrs(id, 'drop-top')}><div class="dh"><h2 id="${id}">${esc(d.h || r.titleThai)}</h2>${d.hAct ? `<button class="btn g sm"${go(d.hAct.go)}${d.hAct.toast ? ` data-toast="${esc(d.hAct.toast)}"` : ''}>${esc(d.hAct.l)}</button>` : ''}${xBtn}</div>${d.search ? srch(d.search) : ''}<div class="sbody" style="padding:0">${panelBody(d, s, 'A')}</div>${d.foot ? `<div class="sfoot"><button class="btn"${go(d.foot.go)}>${esc(d.foot.l)}</button></div>` : ''}</div></div>`; },
    B: (d, r, s) => { const id = nid(); return `<div class="ov" data-back-bg><div ${dlgAttrs(id, 'sheet')} style="height:72%"><div class="grab" aria-hidden="true"></div><div class="dh"><h2 id="${id}">${esc(d.h || r.titleThai)}</h2>${xBtn}</div>${d.tabs ? seg(d.tabs, nid()) : ''}${d.search ? srch(d.search) : ''}<div class="sbody" style="padding:0">${panelBody(d, s, 'B')}</div>${d.foot ? `<div class="sfoot"><button class="btn p"${go(d.foot.go)}>${esc(d.foot.l)}</button></div>` : ''}</div></div>`; },
    C: (d, r, s) => { const id = nid(); return `<div class="ov"><div ${dlgAttrs(id, 'full')}><div class="dh"><button class="ib" data-back aria-label="ปิด">${I('back')}</button><h2 id="${id}" style="text-align:left">${esc(d.h || r.titleThai)}</h2>${d.hAct ? `<button class="btn g sm"${go(d.hAct.go)}${d.hAct.toast ? ` data-toast="${esc(d.hAct.toast)}"` : ''}>${esc(d.hAct.l)}</button>` : ''}</div>${d.search ? srch(d.search) : ''}${d.quick ? chipsBar(d.quick) : ''}<div class="sbody" style="padding:0">${panelBody(d, s, 'C')}</div>${d.foot ? `<div class="sfoot"><button class="btn p"${go(d.foot.go)}>${esc(d.foot.l)}</button></div>` : ''}</div></div>`; },
  };
  function panelBody(d, s, v) {
    if (s === 'loading') return skel(v);
    if (s === 'empty') return emptyB(d.empty);
    if (s === 'error') return banner(['bad', d.err || 'โหลดไม่สำเร็จ', 'ลองอีกครั้ง']);
    const h = (d.html && (typeof d.html === 'object' ? d.html[v] || d.html.A : d.html)) || '';
    const gs = d.sections || (d.items ? [{ items: d.items }] : []);
    return h + J(gs, (g) => secH(g) + (v === 'B' ? `<div class="cards">${J(g.items, itemB)}</div>` : v === 'C' ? `<div class="grp">${J(g.items, (it, i) => itemC(it, 99, false))}</div>` : `<div class="grp">${J(g.items, itemA)}</div>`));
  }

  /* ---------- render ---------- */
  function prep(id, s) {
    const d0 = FM.defs[id] || { kind: 'state', h: 'ยังไม่ได้ออกแบบ', p: id, acts: [] };
    const d = Object.assign({}, d0, (d0.st || {})[s] || {});
    d._s = s; d._custom = !!(d0.st || {})[s];
    return d;
  }
  const isOv = (id) => { const d = FM.defs[id]; return !!(d && K[d.kind] && K[d.kind].ov); };
  FM.isOverlay = isOv;
  function render(id, v, s, parent) {
    s = s || 'default';
    const r = FM.inv[id] || { id, titleThai: (FM.defs[id] || {}).title || id, module: id.split('.')[0] };
    const d = prep(id, s);
    const kind = K[d.kind] || K.state;
    if (kind.ov) {
      const p = parent || d.over || OVER[r.module] || 'ws.home';
      const base = render(p, v, 'default');
      FID = 'frm' + (++uid);
      let ovh = kind[v](d, r, s);
      if (s === 'success' && !ovh.includes('doneP') && (d.kind === 'confirm' || (d.kind === 'sheet' && !d.done))) ovh = toast(d.okMsg || 'ดำเนินการสำเร็จ');
      return base.replace(/<\/div>\s*$/, ovh + '</div>');
    }
    FID = 'frm' + (++uid);
    const navKind = d.nav !== undefined ? d.nav : d.back && !d.tabs ? null : MODNAV[r.module] || null;
    const handles = ['form', 'auth'].includes(d.kind);
    let out;
    if (!handles && !d._custom && s === 'loading') out = { body: skel(v) };
    else if (!handles && !d._custom && s === 'empty') out = { body: (d.kind === 'list' && d.filters ? chipsBar(d.filters) : '') + emptyB(d.empty) };
    else if (!handles && !d._custom && s === 'error') out = { body: banner(['bad', d.err || 'โหลดข้อมูลไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง', 'ลองอีกครั้ง']) + emptyB({ i: 'refresh', h: 'ยังแสดงข้อมูลไม่ได้', p: 'ข้อมูลล่าสุดที่บันทึกไว้จะกลับมาเมื่อโหลดสำเร็จ' }) };
    else out = kind[v](d, r, s);
    const cur = d.tab || (r.module === 'project' ? 'proj.overview' : id.startsWith('ws.profile') ? 'ws.profile' : id);
    const tb = navKind ? tabs(navKind, cur, v) : '';
    const top = kind.raw ? '' : topbar(v, d, r, navKind);
    const extraBanner = !handles && d.banner && !['detail', 'settings', 'thread'].includes(d.kind) ? banner(d.banner) : '';
    const okToast = s === 'success' && !handles ? toast(d.okMsg || 'บันทึกแล้ว') : d.toast ? toast(d.toast) : '';
    const fab = d.fab && v !== 'C' ? `<button class="fab"${go(d.fab.go)}>${I('plus')}${esc(d.fab.l)}</button>` : '';
    return `<div class="app v${v}${tb ? '' : ' noTabs'}" data-screen="${id}" data-state="${s}">${sb()}${top}${subnav(v, d, id)}<main class="scr" tabindex="-1" aria-label="${esc(d.title || r.titleThai)}">${s === 'offline' ? banner(['warn', 'ออฟไลน์อยู่ · แสดงข้อมูลล่าสุดที่บันทึกไว้']) : ''}${extraBanner}${out.body}</main>${out.foot || ''}${fab}${tb}${okToast}</div>`;
  }
  FM.render = render;
  FM.h = { I, esc, J, pill, tag, av, avs, dot, chart, banner, go };

  /* ---------- runtime: โฟลว์ในกรอบโทรศัพท์ ---------- */
  FM.mount = function (el, o) {
    const f = { el, v: o.v, stack: [{ id: o.id, st: o.state || 'default' }], onNav: o.onNav, live: false };
    const topEntry = () => f.stack[f.stack.length - 1];
    const parentOf = () => { for (let i = f.stack.length - 2; i >= 0; i--) if (!isOv(f.stack[i].id)) return f.stack[i].id; return null; };
    f.draw = (focus) => {
      const t = topEntry();
      el.innerHTML = render(t.id, f.v, t.st, isOv(t.id) ? parentOf() : null) + `<div class="kbd" aria-hidden="true">${'<i></i>'.repeat(30)}</div><div class="homebar" aria-hidden="true"></div>`;
      if (focus) {
        const dlg = el.querySelector('.ov [role="dialog"],.ov [role="alertdialog"],.ov [role="menu"]');
        const target = dlg ? dlg.querySelector('input,select,textarea,button:not([data-back]),[href]') || dlg : el.querySelector('main');
        target && target.focus({ preventScroll: false });
      }
      f.onNav && f.onNav(t.id, t.st, f);
    };
    f.go = (id, st) => { if (!FM.defs[id]) { flash('หน้านี้ยังไม่อยู่ในต้นแบบ: ' + id); return; } f.stack.push({ id, st: st || 'default' }); f.draw(true); };
    f.back = () => { if (f.stack.length > 1) f.stack.pop(); else { const t = topEntry(); if (isOv(t.id)) { const d = FM.defs[t.id]; f.stack = [{ id: d.over || OVER[(FM.inv[t.id] || {}).module] || 'ws.home', st: 'default' }]; } } f.draw(true); };
    f.set = (st) => { topEntry().st = st; f.draw(true); };
    f.reset = (id, st, v) => { if (v) f.v = v; f.stack = [{ id, st: st || 'default' }]; f.draw(false); };
    function flash(m) { const a = el.querySelector('.app'); if (!a) return; a.querySelectorAll('.toast').forEach((x) => x.remove()); a.insertAdjacentHTML('beforeend', toast(m)); setTimeout(() => { const t = a.querySelector('.toast'); t && t.remove(); }, 2600); }
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-go],[data-back],[data-tab],[data-chip],[data-st],[data-toast],[data-gst],[data-done]');
      if (e.target.matches('[data-back-bg]')) { f.back(); return; }
      if (!t || !el.contains(t)) return;
      if (t.matches('[data-done]')) { if (t.checked) flash('ทำเครื่องหมายเสร็จแล้ว'); return; }
      if (t.matches('[data-tab]')) { const g = t.closest('[data-tabs]'); const gid = g.dataset.tabs; g.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b === t)); el.querySelectorAll(`[data-for="${gid}"]`).forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab)); return; }
      if (t.matches('[data-chip]') && !t.matches('[data-go],[data-toast]')) { const g = t.closest('[data-single]'); if (g) g.querySelectorAll('[data-chip]').forEach((b) => b.setAttribute('aria-pressed', b === t)); else t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') !== 'true'); return; }
      if (t.tagName === 'BUTTON' && t.form && t.type === 'submit' && !t.matches('[data-go],[data-st],[data-back],[data-gst]')) return; // ปล่อยให้ submit ทำงาน
      e.preventDefault();
      if (t.matches('[disabled],[aria-disabled="true"]')) return;
      if (t.matches('[data-back]')) return f.back();
      if (t.matches('[data-go]')) return f.go(t.dataset.go, t.dataset.gst);
      if (t.matches('[data-st]')) return f.set(t.dataset.st);
      if (t.matches('[data-gst]')) return f.set(t.dataset.gst);
      if (t.matches('[data-toast]')) return flash(t.dataset.toast);
    });
    el.addEventListener('submit', (e) => {
      const form = e.target; e.preventDefault();
      let first = null;
      form.querySelectorAll('[data-req]').forEach((inp) => {
        const empty = inp.type === 'checkbox' ? !inp.checked : !inp.value.trim();
        const badEmail = !empty && inp.type === 'email' && !/^\S+@\S+\.\S+$/.test(inp.value);
        const bad = empty || badEmail;
        inp.setAttribute('aria-invalid', bad);
        const err = inp.id ? el.querySelector('#' + inp.id + 'e') : inp.closest('form').querySelector('.err');
        if (err) { err.hidden = !bad; if (badEmail) err.querySelector('span') && (err.querySelector('span').textContent = 'รูปแบบอีเมลไม่ถูกต้อง'); }
        if (bad && !first) first = inp;
      });
      if (first) { first.focus(); return; }
      if (form.dataset.fgo) return f.go(form.dataset.fgo);
      if (form.dataset.fgst) return f.set(form.dataset.fgst);
      if (form.hasAttribute('data-close')) { f.back(); setTimeout(() => flash(form.dataset.ok || 'บันทึกแล้ว'), 0); return; }
      flash(form.dataset.ok || 'บันทึกแล้ว'); if (form.classList.contains('composer')) form.reset();
    });
    el.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-match]')) { const ok = t.value.trim() === t.dataset.match; t.closest('.dlg,.as').querySelectorAll('[data-needs]').forEach((b) => { b.disabled = !ok; b.setAttribute('aria-disabled', !ok); }); }
      if (t.closest('.otp') && t.value) { const n = t.nextElementSibling; n && n.focus(); }
      if (t.matches('[data-filter]')) { const q = t.value.trim(); t.closest('.dlg').querySelectorAll('.mi').forEach((m) => (m.hidden = q && !m.textContent.includes(q))); }
      if (t.matches('[aria-invalid="true"]') && t.value) { t.setAttribute('aria-invalid', 'false'); const er = t.id && el.querySelector('#' + t.id + 'e'); if (er) er.hidden = true; }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.querySelector('.ov')) { e.preventDefault(); f.back(); return; }
      if (e.key === 'Backspace' && e.target.closest('.otp') && !e.target.value) { const p = e.target.previousElementSibling; p && p.focus(); }
      if (e.key === 'Tab') { const d = el.querySelector('.ov > *'); if (!d) return; const fs = [...d.querySelectorAll('button,input,select,textarea,[href],[tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null); if (!fs.length) return; const a = fs[0], z = fs[fs.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } }
    });
    f.draw(false);
    return f;
  };
})();
