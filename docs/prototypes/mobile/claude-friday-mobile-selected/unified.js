/* Friday Mobile · Unified preview
 * ใช้ engine เดิม (FM.render) แต่ "ประกอบ" หน้าใหม่ตามระบบเดียว:
 *  - เนื้อหา (body) เลือกฐาน A/B/C ตามชนิดหน้า (POLICY) หรือ override ราย ID
 *  - โครงร่วม (หัวหน้า, เมนูย่อย, แถบล่าง) มาจาก B เสมอ ยกเว้นหน้า C ที่ใช้แถบบริบทของ C (ปรับโทนสว่างใน unified.css)
 *  - popup: ฉากหลังเป็นหน้าแม่ที่ประกอบแบบ unified แล้ว + ชั้น overlay จากฐานของ popup นั้น
 * ลิงก์ถาวร: #/<id>/<state>?w=390 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = FM.h.esc;
  const ORIG = '../claude-friday-mobile-complete/';

  /* ---------- นโยบายเลือกฐาน ---------- */
  const POLICY = {
    dash: ['B', 'ภาพรวม/แดชบอร์ด → B การ์ดสงบ อ่านง่าย'],
    settings: ['B', 'ตั้งค่า/โปรไฟล์ → B กลุ่มการ์ด'],
    article: ['B', 'บทความ/เนื้อหายาว → B'],
    market: ['B', 'หน้าเลือกแผน/แค็ตตาล็อก → B การ์ด'],
    board: ['B', 'บอร์ด → B คอลัมน์ scroll-snap (ย้ายด้วย sheet)'],
    timeline: ['B', 'ไทม์ไลน์/Gantt → B การ์ดตามสัปดาห์'],
    cal: ['B', 'ปฏิทิน → B agenda ตามวัน'],
    state: ['B', 'หน้าสถานะระบบ → B'],
    auth: ['B', 'ยืนยันตัวตน → B (ฟอร์มสงบ ไม่มีแถบล่าง)'],
    list: ['A', 'รายการหนาแน่น (งาน/กล่องข้อความ/สมาชิก) → A แถวกระชับ ในกลุ่มขอบมนของ B'],
    table: ['A', 'ตาราง → A ตารางจริง คอลัมน์แรกตรึง'],
    thread: ['A', 'เธรด/แชต → A กระชับ'],
    detail: ['C', 'รายละเอียดงาน/วัตถุ → C การ์ดบริบท + การกระทำหลักติดล่าง'],
    form: ['C', 'ฟอร์มเต็มหน้า → C การ์ดบริบท + ปุ่มหลักใหญ่ล่าง'],
    sheet: ['C', 'sheet สร้าง/แก้ไข/คำขอ → C sheet + ทางลัด + ปุ่มหลักล่าง'],
    confirm: ['C', 'ยืนยัน → C action sheet แสดงผลกระทบ + เลิกทำ'],
    menu: ['B', 'เมนู → B action sheet ล่างจอ (เอื้อมถึงง่ายกว่า popover ของ A; C เต็มจอหนักเกินสำหรับเมนูสั้น)'],
    panel: ['B', 'แผง (กระดิ่ง/สลับ Workspace/ค้นหาด่วน) → B sheet ครึ่งจอ + แท็บ'],
  };
  const OVERRIDE = {
    'u.projects': ['B', 'แท็บโปรเจกต์เป็นหน้าภาพรวม → B การ์ด + progress (แม้ชนิดเป็น list)'],
  };
  const OVER = { public: 'pub.landing', workspace: 'ws.home', project: 'proj.board', issue: 'iss.detail', admin: 'adm.overview', billing: 'bill.overview', help: 'help.center', ops: 'ops.m', auth: 'auth.login', system: 'ws.home' };
  const choice = (id) => { const d = FM.defs[id]; if (!d) return null; const o = OVERRIDE[id]; if (o && o[1]) return { v: o[0], why: o[1], rule: 'override' }; const p = POLICY[d.kind] || ['B', 'ค่าเริ่มต้น B']; return { v: o ? o[0] : p[0], why: p[1], rule: 'kind:' + d.kind }; };
  const pick = (id) => (choice(id) || { v: 'B' }).v;

  /* ---------- ประกอบหน้า ---------- */
  const HDR = /<header class="bar[^"]*">[\s\S]*?<\/header>/;
  const NAVR = /<nav class="(?:tabs[^"]*|dock)"[\s\S]*?<\/nav>/;
  function parts(h) {
    const m = h.match(HDR), mi = h.indexOf('<main class="scr"');
    return { hdr: m ? m[0] : '', hi: m ? m.index : -1, sub: m && mi > 0 ? h.slice(m.index + m[0].length, mi) : '', mi };
  }
  const fixTabs = (nav) => nav.replace('data-go="proj.overview"', 'data-go="u.projects"');
  function screen(id, st) {
    const V = pick(id);
    let h = FM.render(id, V, st);
    if (V !== 'B') {
      const b = FM.render(id, 'B', st), pb = parts(b), pv = parts(h);
      if (pv.hdr && pb.hdr) {
        const hdr = V === 'C' ? pv.hdr : pb.hdr; // C เก็บแถบบริบทของตัวเอง
        h = h.slice(0, pv.hi) + hdr + pb.sub + h.slice(pv.mi);
      }
      const bn = b.match(NAVR);
      h = h.replace(NAVR, bn ? fixTabs(bn[0]) : '');
      if (bn && /noTabs/.test(h.slice(0, 200))) h = h.replace(' noTabs', '');
    } else h = h.replace(NAVR, (n) => fixTabs(n));
    return h.replace(/class="app v([ABC])/, 'class="app uni v$1');
  }
  function compose(id, st, parent) {
    if (!FM.isOverlay(id)) return screen(id, st);
    const d = FM.defs[id], r = FM.inv[id] || {};
    const p = parent || d.over || OVER[r.module] || 'ws.home';
    const full = FM.render(id, pick(id), st, p);
    let i = full.lastIndexOf('<div class="ov');
    if (i < 0) i = full.lastIndexOf('<div class="toast"');
    const layer = i < 0 ? '' : full.slice(i, full.lastIndexOf('</div>'));
    const base = screen(p, 'default');
    return base.replace(/<\/div>\s*$/, layer + '</div>');
  }
  FM.compose = compose;

  /* ---------- runtime ในกรอบ (ดัดแปลงจาก FM.mount เดิมให้ใช้ compose) ---------- */
  function mount(el, o) {
    const f = { stack: [{ id: o.id, st: o.state || 'default' }] };
    const top = () => f.stack[f.stack.length - 1];
    const isOv = FM.isOverlay;
    const parentOf = () => { for (let i = f.stack.length - 2; i >= 0; i--) if (!isOv(f.stack[i].id)) return f.stack[i].id; return null; };
    const toastH = (m) => `<div class="toast" role="status">${FM.h.I('check')}<span>${esc(m)}</span></div>`;
    function flash(m) { const a = el.querySelector('.app'); if (!a) return; a.querySelectorAll('.toast').forEach((x) => x.remove()); a.insertAdjacentHTML('beforeend', toastH(m)); setTimeout(() => { const t = a.querySelector('.toast'); t && t.remove(); }, 2600); }
    f.draw = (focus) => {
      const t = top();
      el.innerHTML = compose(t.id, t.st, isOv(t.id) ? parentOf() : null) + `<div class="kbd" aria-hidden="true">${'<i></i>'.repeat(30)}</div><div class="homebar" aria-hidden="true"></div>`;
      if (focus) {
        const dlg = el.querySelector('.ov [role="dialog"],.ov [role="alertdialog"],.ov [role="menu"]');
        const tg = dlg ? dlg.querySelector('input,select,textarea,button:not([data-back]),[href]') || dlg : el.querySelector('main');
        tg && tg.focus({ preventScroll: false });
      }
      o.onNav && o.onNav(t.id, t.st, f.stack.map((x) => x.id));
    };
    f.go = (id, st) => { if (!FM.defs[id]) { flash('หน้านี้ยังไม่อยู่ในต้นแบบ: ' + id); return; } f.stack.push({ id, st: st || 'default' }); f.draw(true); };
    f.back = () => { if (f.stack.length > 1) f.stack.pop(); else { const t = top(); if (isOv(t.id)) { const d = FM.defs[t.id]; f.stack = [{ id: d.over || OVER[(FM.inv[t.id] || {}).module] || 'ws.home', st: 'default' }]; } } f.draw(true); };
    f.set = (st) => { top().st = st; f.draw(true); };
    f.reset = (id, st) => { f.stack = [{ id, st: st || 'default' }]; f.draw(false); };
    el.addEventListener('click', (e) => {
      if (e.target.matches('[data-back-bg]')) { f.back(); return; }
      const t = e.target.closest('[data-go],[data-back],[data-tab],[data-chip],[data-st],[data-toast],[data-gst],[data-done]');
      if (!t || !el.contains(t)) return;
      if (t.matches('[data-done]')) { if (t.checked) flash('ทำเครื่องหมายเสร็จแล้ว'); return; }
      if (t.matches('[data-tab]')) { const g = t.closest('[data-tabs]'); const gid = g.dataset.tabs; g.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b === t)); el.querySelectorAll(`[data-for="${gid}"]`).forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab)); return; }
      if (t.matches('[data-chip]') && !t.matches('[data-go],[data-toast]')) { const g = t.closest('[data-single]'); if (g) g.querySelectorAll('[data-chip]').forEach((b) => b.setAttribute('aria-pressed', b === t)); else t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') !== 'true'); return; }
      if (t.tagName === 'BUTTON' && t.form && t.type === 'submit' && !t.matches('[data-go],[data-st],[data-back],[data-gst]')) return;
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
        const err = inp.id ? el.querySelector('#' + inp.id + 'e') : form.querySelector('.err');
        if (err) { err.hidden = !bad; if (badEmail && err.querySelector('span')) err.querySelector('span').textContent = 'รูปแบบอีเมลไม่ถูกต้อง'; }
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
  }

  /* ---------- โฟลว์หลัก ---------- */
  const FLOWS = [
    { h: 'หน้าหลัก → งาน → แก้ไข', start: 'ws.home', steps: ['หน้าหลัก (B)', 'แตะงาน FM-142 → รายละเอียด (C)', 'ปุ่มแก้ไข ✎ → sheet แก้ไข (C) → บันทึก → toast'] },
    { h: 'สร้างงาน', start: 'ws.home', steps: ['FAB "สร้างงาน" บนหน้าหลัก', 'sheet สร้างงาน (C) ทางลัด + ปุ่มหลักล่าง', 'สร้าง → หน้าสำเร็จ → เปิดงาน'] },
    { h: 'งานของฉัน (หนาแน่น)', start: 'ws.my-tasks', steps: ['แถวกระชับ A ในกลุ่มการ์ด', 'ตัวกรอง (แถบบน) → sheet', 'แตะงาน → รายละเอียด → ขอเลื่อน'] },
    { h: 'กล่องข้อความ → อนุมัติ', start: 'ws.inbox', steps: ['กล่องข้อความ (A)', 'แตะคำขอของนิดา → อนุมัติเลื่อน (C sheet)', 'หรือแตะการกล่าวถึง → กิจกรรม'] },
    { h: 'โปรเจกต์', start: 'u.projects', steps: ['แท็บโปรเจกต์ → รายการโปรเจกต์ (B)', 'Mobile App → ภาพรวม (B)', '"มุมมอง ▾" → บอร์ด / Gantt / ปฏิทิน'] },
    { h: 'ลบงาน (ยืนยัน)', start: 'iss.detail', steps: ['รายละเอียดงาน → ⋯', 'เมนู (B action sheet) → ลบงาน', 'ยืนยัน (C) แสดงผลกระทบ → toast + เลิกทำ'] },
    { h: 'สลับ Workspace', start: 'ws.switcher', steps: ['โลโก้มุมซ้ายบนทุกหน้าแท็บ', 'แผง B ครึ่งจอ + ค้นหา', 'เลือก Workspace → หน้าหลัก'] },
    { h: 'โปรไฟล์ → ออกจากระบบ', start: 'ws.profile', steps: ['แท็บ "ฉัน" (B)', 'หมวด ▾ → ความปลอดภัย / 2FA', 'ออกจากระบบผ่านเมนูบัญชี → ยืนยัน'] },
    { h: 'Ops · Abuse (canvas-only)', start: 'ops.abuse', steps: ['Ops เมนู → Abuse', 'รายการ A + ป้าย canvas-only', 'ระงับ Workspace → ยืนยัน'] },
  ];

  /* ---------- เปลือกพรีวิว ---------- */
  (async function boot() {
    let inv;
    try { inv = await (await fetch(ORIG + 'inventory.json', { cache: 'no-store' })).json(); }
    catch (e) { $('#crumb').innerHTML = `<div class="card" style="max-width:520px"><h3>โหลด inventory.json ไม่ได้</h3><p class="mut">ต้องเสิร์ฟโฟลเดอร์แม่ (scratch/) ผ่าน HTTP เพื่อให้ ${esc(ORIG)} เข้าถึงได้</p><code>${esc(e.message)}</code></div>`; return; }
    const PFX = inv.pathPrefixes || {};
    inv.entries.forEach((e) => (FM.inv[e.id] = e));
    FM.U_EXTRA.forEach((e) => (FM.inv[e.id] = Object.assign({ extra: true }, e)));
    const ALL = [...inv.entries, ...FM.U_EXTRA.map((e) => Object.assign({ extra: true }, e))];
    const MODS = [...new Set(ALL.map((e) => e.module))];
    const MODNAME = { public: 'สาธารณะ', system: 'ระบบ/สถานะ', auth: 'ยืนยันตัวตน', workspace: 'Workspace', project: 'โปรเจกต์', issue: 'งาน (Issue)', admin: 'Admin Console', billing: 'Billing', help: 'ช่วยเหลือ', ops: 'Friday Ops' };
    const TYPENAME = { screen: 'หน้าจอ', dialog: 'Dialog', sheet: 'Sheet', menu: 'เมนู', panel: 'แผง', state: 'สถานะ' };
    const choices = {}; const missing = [];
    ALL.forEach((e) => { const c = choice(e.id); if (c) choices[e.id] = c.v; else missing.push(e.id); });
    const cnt = (v) => Object.values(choices).filter((x) => x === v).length;
    window.FM_UNIFIED = { originalTotal: inv.entries.length, extras: FM.U_EXTRA.map((e) => e.id), total: ALL.length, rendered: Object.keys(choices).length, byBase: { A: cnt('A'), B: cnt('B'), C: cnt('C') }, missing, choices };
    $('#cov').innerHTML = `เดิม ${inv.entries.length} + ใหม่ ${FM.U_EXTRA.length} = <b>${ALL.length}</b> รายการ · render ได้ ${Object.keys(choices).length}${missing.length ? ` · <span style="color:var(--danger-text)">ขาด ${missing.length}</span>` : ''}<br>ฐาน B ${cnt('B')} · A ${cnt('A')} · C ${cnt('C')}`;
    MODS.forEach((m) => $('#fMod').insertAdjacentHTML('beforeend', `<option value="${m}">${MODNAME[m] || m}</option>`));
    $('#flows').innerHTML = FLOWS.map((f, i) => `<div class="flow"><b>${i + 1}. ${esc(f.h)}</b><ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol><button class="btn sm" data-flow="${f.start}">เริ่มโฟลว์</button></div>`).join('');

    const S = { id: 'ws.home', st: 'default', w: 390, kb: false, land: false, trail: [] };
    const src = (s) => { const m = /^([A-Z]+):(.*)$/.exec(s); return m && PFX[m[1]] ? PFX[m[1]] + m[2] : s; };
    function readHash() {
      const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
      const [id, st] = path.split('/');
      if (id && FM.inv[id]) S.id = id;
      const e = FM.inv[S.id]; S.st = st && e.states.includes(st) ? st : e.states[0];
      const p = new URLSearchParams(qs || ''); if (p.get('w')) S.w = +p.get('w');
    }
    const writeHash = () => history.replaceState(null, '', `#/${S.id}/${S.st}?w=${S.w}`);
    function renderList() {
      const q = $('#q').value.trim().toLowerCase(), fm = $('#fMod').value, fb = $('#fBase').value;
      const hit = ALL.filter((e) => (!fm || e.module === fm) && (!fb || (fb === 'N' ? e.extra : choices[e.id] === fb)) && (!q || (e.id + ' ' + e.titleThai + ' ' + (e.sources || []).join(' ')).toLowerCase().includes(q)));
      $('#lst').innerHTML = MODS.map((m) => { const it = hit.filter((e) => e.module === m); if (!it.length) return ''; return `<h2>${MODNAME[m] || m}<span>${it.length}</span></h2>` + it.map((e) => `<a href="#/${e.id}" data-id="${e.id}"${e.id === S.id ? ' aria-current="true"' : ''}><span class="bx ${e.extra ? 'N' : choices[e.id] || ''}" title="ฐาน ${choices[e.id] || '-'}">${choices[e.id] || '!'}</span><span>${esc(e.titleThai)}</span><small>${e.extra ? 'ใหม่' : TYPENAME[e.type] || e.type}</small></a>`).join(''); }).join('') || '<p class="pad mut">ไม่พบรายการ</p>';
    }
    function renderStates() {
      const e = FM.inv[S.id];
      $('#sts').innerHTML = `<span class="mut">สถานะของ <b>${esc(e.id)}</b>:</span>` + e.states.map((s) => `<button data-st="${s}" aria-pressed="${s === S.st}">${s}</button>`).join('');
    }
    function renderInfo() {
      const e = FM.inv[S.id], c = choice(S.id) || {}, d = FM.defs[S.id] || {};
      const ad = (FM.U_ADAPT[S.id] || []).slice();
      if (c.v === 'A') ad.push('หัวหน้า/เมนูย่อย/แถบล่างจาก B · แถวกระชับของ A อยู่ในกลุ่มขอบมน');
      if (c.v === 'C' && !FM.isOverlay(S.id)) ad.push('แถบบริบทของ C ปรับเป็นโทนสว่าง · ไม่มี dock เข้ม (ใช้แถบล่าง B)');
      if (c.v === 'C' && FM.isOverlay(S.id)) ad.push('ชั้น popup จาก C วางบนหน้าแม่ที่ประกอบแบบ unified');
      if (c.v === 'B' && FM.isOverlay(S.id)) ad.push('ชั้น popup จาก B (action sheet/ครึ่งจอ) วางบนหน้าแม่แบบ unified');
      const orig = e.extra ? '' : `<a class="lnk" style="min-height:0" target="_blank" href="${ORIG}index.html#/${e.id}/${c.v}/${S.st}?w=${S.w}">เปิดต้นฉบับ ${c.v}</a> · <a class="lnk" style="min-height:0" target="_blank" href="${ORIG}index.html#/${e.id}/A/${S.st}?w=${S.w}&m=compare">เทียบ A·B·C</a>`;
      $('#info').innerHTML = `<div class="k">${esc(e.id)}</div><h2 style="margin:4px 0 6px;font-size:18px">${esc(e.titleThai)}</h2>
        <span class="pill t-info">ฐาน ${esc(c.v || '-')}</span> <span class="pill t-mute">${TYPENAME[e.type] || e.type}</span> <span class="pill t-mute">kind: ${esc(d.kind || '-')}</span> ${e.extra ? '<span class="pill t-warn">เพิ่มใหม่</span>' : ''}
        <h3>เหตุผลที่เลือกฐาน</h3><p>${esc(c.why || '')} <span class="mut">(${esc(c.rule || '')})</span></p>
        <h3>การปรับให้เป็นระบบเดียว</h3><ul>${ad.map((s) => `<li>${esc(s)}</li>`).join('') || '<li class="mut">ใช้ layout ฐานตรง ๆ + token/ปุ่ม/ระยะร่วม</li>'}</ul>
        ${e.note ? `<h3>หมายเหตุ</h3><p>${esc(e.note)}</p>` : ''}
        <h3>เส้นทางในกรอบ</h3><div>${S.trail.map((x) => `<code>${esc(x)}</code>`).join(' → ')}</div>
        <h3>ไฟล์ต้นทาง (อ่านอย่างเดียว)</h3><ul>${(e.sources || []).map((s) => `<li><code>${esc(src(s))}</code></li>`).join('')}</ul>
        <h3>การโต้ตอบ</h3><ul>${(e.interactions || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
        ${orig ? `<h3>ต้นฉบับ (แกลเลอรี ABC เดิม)</h3><p>${orig}</p>` : ''}
        <h3>หมายเหตุรวม</h3><p class="mut">ต้นแบบ ไม่เรียก API · ข้อมูลสมมติ · ดีไซน์ส่วนใหญ่ประกอบจาก engine เดิม ยังไม่ได้ขัดเกลาระดับพิกเซลรายหน้า</p>`;
    }
    let frame;
    function draw() {
      const ph = $('#ph');
      ph.className = 'ph' + (S.kb ? ' kb' : '') + (S.land ? ' land' : '');
      ph.style.setProperty('--w', (S.land ? Math.min(Math.round(S.w * 1.9), 740) : S.w) + 'px');
      frame = mount(ph, { id: S.id, state: S.st, onNav: (id, st, trail) => {
        S.trail = trail; const ch = id !== S.id || st !== S.st; S.id = id; S.st = st;
        $('#crumb').textContent = trail.join(' → ');
        writeHash(); if (ch) renderList(); renderStates(); renderInfo();
      } });
      document.querySelectorAll('#wBtns button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.w === S.w));
    }
    const open = (id, st) => { S.id = id; S.st = st || FM.inv[id].states[0]; renderList(); draw(); };

    $('#lst').addEventListener('click', (e) => { const a = e.target.closest('a[data-id]'); if (!a) return; e.preventDefault(); open(a.dataset.id); });
    $('#flows').addEventListener('click', (e) => { const b = e.target.closest('[data-flow]'); if (b) open(b.dataset.flow, 'default'); });
    ['#q', '#fMod', '#fBase'].forEach((s) => $(s).addEventListener('input', renderList));
    $('#sts').addEventListener('click', (e) => { const b = e.target.closest('button[data-st]'); if (!b) return; S.st = b.dataset.st; frame.reset(S.id, S.st); });
    $('#wBtns').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.w = +b.dataset.w; draw(); });
    $('#dark').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light'; });
    $('#kb').addEventListener('change', (e) => { S.kb = e.target.checked; $('#ph').classList.toggle('kb', S.kb); });
    $('#land').addEventListener('change', (e) => { S.land = e.target.checked; draw(); });
    $('#restart').addEventListener('click', () => frame.reset(S.id, S.st));
    $('#home').addEventListener('click', () => open('ws.home', 'default'));
    document.querySelector('.tabsel').addEventListener('click', (e) => { const b = e.target.closest('button[data-pane]'); if (!b) return; document.querySelectorAll('.tabsel button').forEach((x) => x.setAttribute('aria-pressed', x === b)); document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.id !== b.dataset.pane)); });
    window.addEventListener('hashchange', () => { const before = S.id + S.st; readHash(); if (before !== S.id + S.st) { renderList(); draw(); } });
    readHash(); renderList(); draw();
  })();
})();
