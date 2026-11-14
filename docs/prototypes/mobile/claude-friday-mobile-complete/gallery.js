/* แกลเลอรีต้นแบบ · อ่าน inventory.json แล้วแสดงทุกหน้า/popup ใน 3 ทิศทาง
 * ลิงก์ถาวร: #/<id>/<A|B|C>/<state>?w=390&m=single|compare */
(async function () {
  const $ = (s) => document.querySelector(s);
  const esc = FM.h.esc;
  let inv;
  try {
    const r = await fetch('inventory.json', { cache: 'no-store' });
    inv = await r.json();
  } catch (e) {
    $('#canvas').innerHTML = `<div class="err-load card"><h3>โหลด inventory.json ไม่ได้</h3><p class="mut">เบราว์เซอร์บล็อก fetch เมื่อเปิดไฟล์ตรง (file://) ให้เปิดผ่าน HTTP server ภายในเครื่อง เช่น เสิร์ฟโฟลเดอร์นี้แล้วเข้า /index.html</p><code>${esc(e.message)}</code></div>`;
    $('#cov').textContent = 'โหลดไม่สำเร็จ';
    return;
  }
  const E = inv.entries, PFX = inv.pathPrefixes;
  E.forEach((e) => (FM.inv[e.id] = e));
  const MODS = [...new Set(E.map((e) => e.module))];
  const TYPES = inv.types;
  const STATES = [...new Set(E.flatMap((e) => e.states))];
  const MODNAME = { public: 'สาธารณะ', system: 'ระบบ/สถานะ', auth: 'ยืนยันตัวตน', workspace: 'Workspace', project: 'โปรเจกต์', issue: 'งาน (Issue)', admin: 'Admin Console', billing: 'Billing', help: 'ช่วยเหลือ', ops: 'Friday Ops (หลังบ้าน)' };
  const TYPENAME = { screen: 'หน้าจอ', dialog: 'Dialog', sheet: 'Sheet', menu: 'เมนู', panel: 'แผง', state: 'สถานะ' };
  const defined = E.filter((e) => FM.defs[e.id]);
  const missing = E.filter((e) => !FM.defs[e.id]);
  const byType = TYPES.map((t) => `${TYPENAME[t]} ${E.filter((e) => e.type === t).length}`).join(' · ');
  $('#cov').innerHTML = `${E.length} รายการ · ออกแบบแล้ว ${defined.length} × 3 ทิศทาง = <b>${defined.length * 3}</b> พรีวิว${missing.length ? ` · <span style="color:var(--danger-text)">ขาด ${missing.length}</span>` : ''}<br>${byType}`;
  MODS.forEach((m) => $('#fMod').insertAdjacentHTML('beforeend', `<option value="${m}">${MODNAME[m] || m}</option>`));
  TYPES.forEach((t) => $('#fType').insertAdjacentHTML('beforeend', `<option value="${t}">${TYPENAME[t]}</option>`));
  STATES.forEach((s) => $('#fState').insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`));

  const S = { id: E[0].id, v: 'A', st: null, w: 390, mode: 'single', dark: false, kb: false, land: false };
  let frames = [];
  function readHash() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    const [id, v, st] = path.split('/');
    if (id && FM.inv[id]) S.id = id;
    if (v && /^[ABC]$/.test(v)) S.v = v;
    S.st = st && FM.inv[S.id].states.includes(st) ? st : FM.inv[S.id].states[0];
    const p = new URLSearchParams(qs || '');
    if (p.get('w')) S.w = +p.get('w');
    if (p.get('m')) S.mode = p.get('m');
  }
  const hashOf = () => `#/${S.id}/${S.v}/${S.st}?w=${S.w}&m=${S.mode}`;
  const writeHash = () => history.replaceState(null, '', hashOf());
  const src = (s) => { const m = /^([A-Z]+):(.*)$/.exec(s); return m && PFX[m[1]] ? PFX[m[1]] + m[2] : s; };

  function renderList() {
    const q = $('#q').value.trim().toLowerCase(), fm = $('#fMod').value, ft = $('#fType').value, fs = $('#fState').value;
    const hit = E.filter((e) => (!fm || e.module === fm) && (!ft || e.type === ft) && (!fs || e.states.includes(fs)) && (!q || (e.id + ' ' + e.titleThai + ' ' + e.sources.join(' ')).toLowerCase().includes(q)));
    $('#lst').innerHTML = MODS.map((m) => { const it = hit.filter((e) => e.module === m); if (!it.length) return ''; return `<h2>${MODNAME[m] || m}<span>${it.length}</span></h2>` + it.map((e) => `<a href="#/${e.id}/${S.v}" data-id="${e.id}"${e.id === S.id ? ' aria-current="true"' : ''}><span>${esc(e.titleThai)}</span><small${FM.defs[e.id] ? '' : ' class="miss"'}>${TYPENAME[e.type]}</small></a>`).join(''); }).join('') || '<p class="pad mut">ไม่พบรายการ</p>';
  }
  function renderStates() {
    const e = FM.inv[S.id];
    $('#sts').innerHTML = `<span class="mut">สถานะของ <b>${esc(e.id)}</b>:</span>` + e.states.map((s) => `<button data-st="${s}" aria-pressed="${s === S.st}">${s}</button>`).join('');
  }
  function renderInfo() {
    const e = FM.inv[S.id], d = FM.defs[S.id];
    $('#info').innerHTML = `<div class="k">${esc(e.id)}</div><h2 style="margin:4px 0 6px;font-size:18px">${esc(e.titleThai)}</h2><span class="pill t-info">${TYPENAME[e.type]}</span> <span class="pill t-mute">${MODNAME[e.module] || e.module}</span> ${d ? `<span class="pill t-mute">kind: ${esc(d.kind)}</span>` : '<span class="pill t-bad">ยังไม่มีดีไซน์</span>'}
      <h3>ไฟล์ต้นทาง (อ่านอย่างเดียว)</h3><ul>${e.sources.map((s) => `<li><code>${esc(src(s))}</code></li>`).join('')}</ul>
      <h3>สถานะ</h3><div>${e.states.map((s) => `<code>${esc(s)}</code>`).join(' ')}</div>
      <h3>การโต้ตอบ</h3><ul>${e.interactions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <h3>ทิศทาง</h3><ul>${['A', 'B', 'C'].map((v) => `<li><a class="lnk" style="min-height:0" href="#/${e.id}/${v}">${v}</a> ${esc(inv.directions[v])}</li>`).join('')}</ul>
      ${d && d.over ? `<h3>แสดงซ้อนบน</h3><code>${esc(d.over)}</code>` : ''}
      <h3>ลิงก์ถาวร</h3><code>${esc(location.pathname.split('/').pop() || 'index.html')}${esc(hashOf())}</code>
      <h3>หมายเหตุ</h3><p class="mut">ต้นแบบนี้ไม่เรียก API · ปุ่มทั้งหมดเปลี่ยนหน้าหรือสถานะในกรอบเท่านั้น · ข้อมูลเป็นข้อมูลสมมติ</p>`;
  }
  function frameW() { return S.land ? Math.min(Math.round(S.w * 1.9), 740) : S.w; }
  function drawFrames() {
    const vs = S.mode === 'compare' ? ['A', 'B', 'C'] : [S.v];
    const cv = $('#canvas'); cv.innerHTML = '';
    frames = vs.map((v) => {
      const wrap = document.createElement('div'); wrap.className = 'fw';
      const ph = document.createElement('div'); ph.className = 'ph' + (S.kb ? ' kb' : '') + (S.land ? ' land' : '');
      ph.style.setProperty('--w', frameW() + 'px');
      ph.setAttribute('role', 'region'); ph.setAttribute('aria-label', `พรีวิวทิศทาง ${v}`);
      const cap = document.createElement('div'); cap.className = 'cap';
      wrap.append(cap, ph); cv.append(wrap);
      const f = FM.mount(ph, {
        id: S.id, v, state: S.st,
        onNav: (id, st) => {
          cap.innerHTML = `<b>ทิศทาง ${v}</b>${esc(inv.directions[v].split(':')[0])}<br><code>${esc(id)}</code> · ${esc(st)}`;
          if (S.mode === 'single' && (id !== S.id || st !== S.st)) { S.id = id; S.st = st; writeHash(); renderList(); renderStates(); renderInfo(); }
        },
      });
      return f;
    });
    syncToolbar();
  }
  function syncToolbar() {
    document.querySelectorAll('#vBtns button').forEach((b) => b.setAttribute('aria-pressed', S.mode === 'single' && b.dataset.v === S.v));
    document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.m === S.mode));
    document.querySelectorAll('#wBtns button').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.w === S.w));
    $('#fVar').value = S.v;
  }
  function full() { writeHash(); renderList(); renderStates(); renderInfo(); drawFrames(); }

  $('#lst').addEventListener('click', (e) => { const a = e.target.closest('a[data-id]'); if (!a) return; e.preventDefault(); S.id = a.dataset.id; S.st = FM.inv[S.id].states[0]; full(); });
  ['#q', '#fMod', '#fType', '#fState'].forEach((s) => $(s).addEventListener('input', renderList));
  $('#fVar').addEventListener('change', (e) => { S.v = e.target.value; full(); });
  $('#vBtns').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.v = b.dataset.v; S.mode = 'single'; full(); });
  $('#mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.m; full(); });
  $('#wBtns').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.w = +b.dataset.w; full(); });
  $('#sts').addEventListener('click', (e) => { const b = e.target.closest('button[data-st]'); if (!b) return; S.st = b.dataset.st; frames.forEach((f) => f.reset(S.id, S.st)); writeHash(); renderStates(); });
  $('#dark').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light'; });
  $('#kb').addEventListener('change', (e) => { S.kb = e.target.checked; document.querySelectorAll('.ph').forEach((p) => p.classList.toggle('kb', S.kb)); });
  $('#land').addEventListener('change', (e) => { S.land = e.target.checked; drawFrames(); });
  $('#restart').addEventListener('click', () => drawFrames());
  window.addEventListener('hashchange', () => { readHash(); full(); });

  readHash();
  full();
  // ให้ host ตรวจผ่าน DOM ได้: รายการที่ยังไม่มีดีไซน์
  window.FM_COVERAGE = { total: E.length, defined: defined.length, previews: defined.length * 3, missing: missing.map((e) => e.id) };
})();
