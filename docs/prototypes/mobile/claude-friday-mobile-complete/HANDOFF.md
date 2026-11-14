# HANDOFF · Friday Manage Mobile UI (≤760px) — ต้นแบบดีไซน์

> งานนี้เป็นดีไซน์/ต้นแบบเท่านั้น ไม่มีการแก้ repo `Friday_Manage` ไม่มี deploy ไม่มีการเรียก API จริง
> หน้า desktop ไม่ถูกแตะ · ข้อมูลทั้งหมดเป็นข้อมูลสมมติ

## 1. วิธีเปิด

- เสิร์ฟโฟลเดอร์นี้ผ่าน HTTP server ภายในเครื่อง แล้วเปิด `index.html` (แกลเลอรีใช้ `fetch('inventory.json')` จึงเปิดผ่าน `file://` ไม่ได้ หน้าจะแสดงข้อความแจ้งถ้าโหลดไม่ได้)
- ลิงก์ถาวรของแต่ละรายการ: `index.html#/<id>/<A|B|C>/<state>?w=390&m=single|compare`
  เช่น `#/iss.detail/C/default?w=375` · `#/auth.reset/B/link-invalid` · `#/ws.home/A/default?m=compare`
- แถบควบคุม: ทิศทาง A/B/C · โหมด "เทียบ A·B·C" (มุมมอง desktop สำหรับเทียบ 3 ทิศทางของ **mobile** ไม่ใช่ desktop production) · ความกว้าง 320/375/390/430 · มืด · คีย์บอร์ดจำลอง · แนวนอน · ตัวกรองโมดูล/ชนิด/สถานะ + ค้นหา
- `window.FM_COVERAGE` ในหน้าแกลเลอรีให้ host ตรวจจำนวนผ่าน DOM ได้ (`total`, `defined`, `previews`, `missing`)

## 2. ขอบเขตและตัวเลข (คำนวณจาก `inventory.json`)

| โมดูล | รายการ |
|---|---|
| public (สาธารณะ) | 6 |
| system (สถานะระบบ) | 3 |
| auth (ยืนยันตัวตน) | 10 |
| workspace | 33 |
| project | 43 |
| issue | 15 |
| admin | 18 |
| billing | 6 |
| help | 6 |
| **ops (Friday Ops · โมดูลแยก)** | 49 |
| **รวม** | **189** |

| ชนิด | จำนวน |
|---|---|
| screen | 109 |
| state (หน้าสถานะ) | 5 |
| sheet | 38 |
| dialog | 20 |
| menu | 11 |
| panel | 6 |
| **popup รวม (sheet+dialog+menu+panel)** | **75** |

- ทุก 189 รายการมี definition ใน `data/*.js` และ render ได้ทั้ง 3 ทิศทาง → **567 พรีวิว** (189 × 3)
- ทุกรายการมีตัวสลับสถานะตามที่ระบุใน inventory (default/loading/empty/error/success และสถานะเฉพาะ เช่น `mfa`, `link-invalid`, `resend-ready`, `step1–3`, `pending`, `suspended`, `forbidden`, `workload/members/invites`)
- ที่มา: route ของ `apps/web/app/**/page.tsx` (42 ไฟล์ ไม่นับ `.next`), `apps/ops-web/app/**/page.tsx` (35), Canvas `design/canvas/*.dc.html` + `design/canvas/ops/*.dc.html` (83), component popup ใน `apps/web/src/features/**` และ `_components/**`
- catch-all ถูกขยายแล้ว: `admin/[[...section]]` → 12 หมวด (`types.ts` SECTIONS + notify-templates) · `p/[key]/settings/[[...section]]` → 11 หมวด (9 หมวดเป็นหน้าของตัวเอง, 2 หมวดชี้ไปหน้าเดิม) · `billing/[[...section]]` → overview/plans + checkout · `legal/[type]` → terms/privacy เป็นสถานะ

### รายการที่ไม่ได้ทำเป็นหน้าแยก (พร้อมเหตุผล)

| ที่มา | เหตุผล |
|---|---|
| `apps/web/app/dev/ui/page.tsx` | UI gallery สำหรับนักพัฒนา |
| `apps/web/.next/standalone/**` (`/w/[ws]`) | ผลลัพธ์ build เก่า ซ้ำกับ `/work/[ws]` |
| `TaskDetail`, `TaskCreate`, `SubtaskModal` (.dc.html) | เวอร์ชันเก่า ใช้ V2 แทน |
| `Mobile*.dc.html` 6 ไฟล์ | ใช้เป็นแหล่งอ้างอิงของหน้าเดียวกัน ไม่ใช่หน้าใหม่ |
| settings `import`, `plan-changes` | ซ้ำกับ `proj.import`, `proj.plan-changes` (เมนูตั้งค่าลิงก์ไปหน้าเดียวกัน) |
| settings `trash`, admin `trash` | ซ้ำกับ `ws.trash` (ขอบเขตต่างกัน ดีไซน์เดียว) |
| `Localization.dc.html`, `ReviewGuide.dc.html` | ไม่ใช่หน้าจอ |
| `SuperAdmin.dc.html` | แบบเดิมของหลังบ้าน ถูกแทนด้วย ops-web |
| `ops/Abuse.dc.html` | มีใน Canvas แต่ **ยังไม่มี route** ใน ops-web → ไม่ทำ (ควรตัดสินใจก่อนว่าจะ implement) |
| `ops/Topbar`, `ops/Sidebar` | เป็นโครงหน้า ใช้ใน `ops.menu` และแถบล่าง Ops |

## 3. ทิศทางดีไซน์ 3 แบบ

| | A · กระชับ เน้นงาน | B · สงบ เน้นการ์ด | C · ตามบริบท เน้นการกระทำ |
|---|---|---|---|
| แถบบน | 52px ชื่อหน้า + ไอคอน | หัวข้อใหญ่ 26px + คำอธิบาย | พื้นเข้ม + ชิปบริบท (Sprint, เลยกำหนด ฯลฯ) |
| นำทางหลัก | tab bar 5 เมนู | tab bar แบบ pill | dock ลอย + ปุ่มสร้างตรงกลาง |
| มุมมองย่อย (โปรเจกต์/ตั้งค่า) | ชิปเลื่อนแนวนอน | ปุ่ม "มุมมอง ▾" เปิด sheet / dropdown | แท็บขีดเส้นใต้ |
| รายการ | แถวหนาแน่น จุดสถานะ + คีย์ | การ์ด สถานะ ผู้รับผิดชอบ progress | สรุปบริบท + quick actions + checkbox + ปัดซ้าย |
| บอร์ด | แท็บทีละคอลัมน์ + ปุ่ม "ย้าย" | คอลัมน์ scroll-snap ในกรอบ | accordion ตามสถานะ + ชิป "ไป <สถานะถัดไป>" |
| ตาราง | ตารางจริง คอลัมน์แรกตรึง เลื่อนในกรอบ | การ์ดต่อแถว | เลือกคอลัมน์หลัก + แถวขยายได้ |
| Gantt/ไทม์ไลน์ | กริดเลื่อนในกรอบ ชื่องานตรึง | การ์ดตามสัปดาห์ + แถบช่วงวัน | แถบวัน + "วันนี้ทำอะไร" + แบนเนอร์เลยกำหนด |
| ปฏิทิน | เดือน + agenda วันที่เลือก | agenda ตามวัน | แถบสัปดาห์ + ตารางชั่วโมง |
| ฟอร์ม | คอลัมน์เดียว ปุ่มหลักติดล่าง | กลุ่มเป็นการ์ด | การ์ดบริบท + ฟิลด์แบบแถว (label ซ้าย) |
| sheet/ฟอร์มใน popup | เต็มจอ (ยกเลิก · ชื่อ · บันทึก) | bottom sheet มีที่จับ + ปุ่มล่าง | sheet + การ์ดบริบท + ทางลัด + ปุ่มหลักใหญ่ |
| ยืนยัน | alert กลางจอ | sheet แสดงผลกระทบ | action sheet + ข้อความเลิกทำ |
| เมนู | popover มุมขวาบน | action sheet | เต็มจอ + ค้นหา (เมื่อ >5 รายการ) |
| แผง (กระดิ่ง ฯลฯ) | เลื่อนลงจากบน | sheet ครึ่งจอ + แท็บ | เต็มจอ + ชิปกรอง |

## 4. Source → design (โดยย่อ)

รายการเต็มพร้อมไฟล์ต้นทางของทุก ID อยู่ใน `inventory.json` (`sources`, `states`, `interactions`) และแสดงในแผงขวาของแกลเลอรี

| ไฟล์ต้นทาง | ID |
|---|---|
| `(auth)/login/_components/login-form.tsx` (`mfaRequired`, `invalid_mfa_code`, `mfa_token_invalid`, backup) | `auth.login`, `auth.login-mfa`, `auth.login-backup` |
| `(auth)/signup/_components/signup-form.tsx` (OtpInput) | `auth.signup`, `auth.signup-verify` |
| `(auth)/forgot-password/_components/forgot-password-flow.tsx` (Dots 1–3, retryAfter, `invalid_token`, `logoutAll`) | `auth.forgot`, `auth.forgot-sent`, `auth.reset` |
| `src/features/issue-drawer/*` | `iss.detail`, `iss.create`, `iss.due-request`, `iss.due-approve`, `iss.activity`, `iss.status-menu`, `iss.assignee`, `iss.date`, `iss.more`, `iss.attach`, `iss.mention` |
| `p/[key]/board/_components/kanban-board.tsx` | `proj.board`, `proj.board-move`, `proj.board-filter` |
| `p/[key]/settings/_components/types.ts` SECTIONS | `proj.settings-*` |
| `admin/_components/types.ts` SECTIONS | `adm.*` |
| `billing/_components/overview.tsx` (open/pending_review/paid/void) | `bill.overview`, `bill.invoice`, `bill.checkout` (pending) |
| `src/features/trash/dialogs.tsx` | `ws.trash`, `ws.trash-restore`, `ws.trash-purge` |
| `src/features/{bell,whats-new,nps,onboarding-checklist,command-palette,help-panel,plan-limits,checkout,plan-io,project-invite}` | `ws.bell`, `ws.whats-new`, `ws.nps`, `ws.checklist`, `ws.command`, `help.panel`, `bill.plan-limit`, `bill.cancel`, `proj.export`/`proj.import`, `proj.invite` |
| `apps/ops-web/app/(console)/m/*` | `ops.m`, `ops.m-approvals`, `ops.m-incidents`, `ops.m-payments` (เป็นแถบล่างของ Ops) |
| `design/canvas/ops/Modals-*.dc.html` | `ops.refund-approve`, `ops.ws-suspend`, `ops.support-session`, `ops.reauth`, `ops.flag-toggle`, `ops.*-edit`, `ops.restore-confirm`, `ops.states` |

## 5. Shared components (ใน `engine/fm.js`)

- **โครง:** status bar จำลอง, topbar A/B/C, subnav (ชิป/dropdown/แท็บ), tab bar / dock, FAB, toast (มี "เลิกทำ"), banner (bad/warn/ok/info), empty state, skeleton 3 แบบ
- **ข้อมูล:** row, card, swipe row, hero, quick actions, KPI grid / scroller, chart SVG (bar, line+baseline, donut, hbar ภาระงาน), pill สถานะ 7 ค่าจาก token, avatar, definition list, property grid, checklist, timeline, chat message
- **ฟอร์ม:** text/email/number/date/time/url, password + policy meter, textarea, select, chips (single/multi), radio card, switch, checkbox, OTP 6 หลัก (auto-advance/backspace), file drop + ไฟล์ที่เลือก, inline validation (required, email), stepper
- **Overlay:** full-screen modal, bottom sheet, alert dialog, action sheet, popover menu, drop-down panel · `role="dialog|alertdialog|menu"`, `aria-modal`, `aria-labelledby`, focus แรกในกล่อง, focus trap ด้วย Tab, Esc/แตะพื้นหลังเพื่อปิด, type-to-confirm สำหรับการลบถาวร
- **ชนิดหน้า (kind):** list, dash, detail, board, table, timeline, cal, settings, article, market, thread, state, form, auth, sheet, confirm, menu, panel — แต่ละชนิดมี layout A/B/C แยกกัน

**ข้อจำกัดที่ต้องรู้ (ตรงไปตรงมา):** ทิศทางต่างกันในระดับ layout ของแต่ละ *ชนิด* · หน้าที่เป็นชนิดเดียวกัน (เช่น รายการ 2 หน้า) ใช้ layout ของทิศทางเดียวกัน ต่างกันที่เนื้อหา/ฟิลด์/การกระทำ ซึ่งเป็นเจตนาให้ใช้ primitive ร่วมกันได้ใน production

## 6. ขอบเขต mobile ≤760px (จาก repo ปัจจุบัน)

- `apps/web/src/lib/use-mobile.ts`: `MOBILE_QUERY = "(max-width: 760px)"` · `globals.css` มี `@media (max-width: 760px)` 6 จุด · module css ของ trash, command-palette, help, plan-io, whats-new, project-invite, onboarding-checklist ใช้ 760 เหมือนกัน
- **ความไม่สอดคล้อง:** `src/features/issue-drawer/issue-drawer.module.css` ใช้ `@media(max-width:767px)` 2 จุด (บรรทัด ~194, ~309) และ 760 อีก 1 จุด → ช่วง 761–767px drawer เป็น mobile แต่ส่วนอื่นเป็น desktop · **แนะนำ:** เปลี่ยนเป็น 760 หรือดึงจากค่ากลางเดียวกัน แล้วเพิ่ม test ที่ 761/767/768
- **แนวนอน:** โทรศัพท์จริงแนวนอนกว้าง 667–932px ซึ่ง >760 จะได้ layout desktop · ต้นแบบจำลองแนวนอนที่ ≤740px เท่านั้น · ต้องตัดสินใจว่าจะใช้ `(max-width:760px), (max-height:500px) and (pointer:coarse)` หรือไม่ (**ข้อเสนอใหม่** ยังไม่ใช่สเปก)

## 7. กลยุทธ์คง desktop ไว้

1. ทุก style ใหม่ของ mobile อยู่ใน `@media (max-width: 760px)` หรือ component ที่ mount เฉพาะเมื่อ `useMobile()` เป็นจริง
2. ไม่แก้ selector desktop เดิม · ไม่เปลี่ยนค่า token เดิม · token ใหม่ (`--m-tap`, `--m-text-body`, `--m-text-input`, `--m-radius-sheet` — **ข้อเสนอ**) ต้องเพิ่มทั้ง `:root` และ `[data-theme="dark"]` ใน `tokens.css` ตามกติกา AGENTS.md และให้ `src/lib/theme.test.tsx` ผ่าน
3. Popup เดิม (`components/ui/overlays.tsx`) เพิ่ม variant `sheet` สำหรับ mobile โดย API เดิมไม่เปลี่ยน
4. **Baseline regression ที่ต้องมีก่อน merge ทุก PR:** screenshot desktop ที่ 1280, 1440, 1920 ของหน้าที่แตะ (โหมดสว่าง+มืด) เทียบก่อน/หลังต้องไม่ต่าง + 761 และ 768 เพื่อจับเส้นแบ่ง · mobile ที่ 320/375/390/430

## 8. Accessibility / safe-area / keyboard / landscape — checklist

- [ ] เป้าแตะ ≥44×44px (ปุ่ม ชิป แถว แท็บ วันในปฏิทิน)
- [ ] input `font-size ≥16px` กัน iOS ซูม
- [ ] `padding-bottom: env(safe-area-inset-bottom)` บน tab bar, sheet footer, composer, FAB · `viewport-fit=cover`
- [ ] Sheet: `max-height` อิง `100dvh`/`visualViewport` · body เลื่อนได้ · footer ติดล่างและอยู่เหนือคีย์บอร์ด (ต้นแบบจำลองด้วยปุ่ม "คีย์บอร์ด")
- [ ] Dialog: `aria-modal`, ชื่อจาก `aria-labelledby`, focus แรกในกล่อง, trap, Esc ปิด, คืน focus ให้ปุ่มที่เปิด, ปุ่ม back ของ Android/ปัดกลับ = ปิด popup (ใช้ history state)
- [ ] เนื้อหาเลื่อนแนวนอนอยู่ในกรอบของตัวเอง (`overscroll-behavior-x: contain`) ไม่มี document scroll แนวนอน
- [ ] สีผ่าน WCAG AA ทั้งสองโหมด (ใช้ token เดิมเท่านั้น)
- [ ] แนวนอน: ตรวจ 667×375 และ 844×390 ตามการตัดสินใจในข้อ 6
- [ ] VoiceOver/TalkBack: ป้ายสถานะมีข้อความ ไม่ใช้สีอย่างเดียว · กราฟมี `aria-label`

## 9. ข้อเสนอ PR แยกตามโมดูล (ลำดับแนะนำ)

1. **Mobile foundation** — token ใหม่ 2 โหมด, `BottomSheet`/`ActionSheet` ใน overlays, tab bar, แก้ 767→760, test เส้นแบ่ง
2. **Auth** — login/MFA/backup/signup OTP/forgot 3 ขั้น/join/onboarding (ไม่เปลี่ยน API)
3. **Workspace core** — home, my-tasks, inbox, search, bell, command, switcher, account menu
4. **Issue drawer mobile** — detail/subtask/bug, status/assignee/date sheet, due request, comments+mention, attach
5. **Project views** — board (ย้ายด้วย sheet แทนลาก), backlog+bulk, table, timeline/gantt, calendar
6. **Project analytics/admin** — dashboard, reports, files+preview, members/workload, automation, plan changes, import/export
7. **Project settings** — 9 หมวด + dialog ลบ/archive/status/type
8. **Profile & trash** — 4 แท็บ, 2FA setup, password, sessions, trash restore/purge
9. **Admin Console** — 12 หมวด + sheet
10. **Billing & help** — overview/plans/checkout/invoice/cancel/plan-limit, help center/article/contact/tickets
11. **Public** — landing, pricing, legal, help สาธารณะ
12. **Friday Ops** (deploy ชุด `compose.ops.yml` แยก) — ขยาย `/m/*` เดิม, เมนูรวม, modal เงิน/ความปลอดภัย

## 10. Business rules ที่คงไว้ / พฤติกรรมใหม่ที่เป็นข้อเสนอ

**คงไว้ตามโค้ด/สเปก:** วันที่ `YYYY-MM-DD` และวันทำการตาม WorkCalendar · Man-Day · Guest ถูกตัดข้อมูลที่ API · Admin Console ไม่เรียก API สำหรับ Member/Guest · mfaToken หมดอายุ 5 นาที · ลิงก์รีเซ็ตใช้ `invalid_token` · ถังขยะ 30 วัน · สถานะ invoice open/pending_review/paid/void · workflow หมวด todo/in_progress/review/done/cancelled · settings ที่ต้องมี `project.baseline`

**ข้อเสนอใหม่ (ยังไม่มีสัญญา API/สเปก ต้องยืนยันก่อนทำ):**
- ปัดซ้ายที่แถวงานเพื่อ "เสร็จ/ขอเลื่อน" (ทิศทาง C)
- ชิป "ไป <สถานะถัดไป>" บนบอร์ด (ใช้ transition เดิมของ workflow)
- ทางลัด +1 วัน/+3 วัน ในคำขอเลื่อน และการแสดงผลกระทบต่อ Milestone ใน dialog
- ปุ่ม "ทดสอบกฎกับงานล่าสุด" ใน rule editor
- ภาระงานของผู้รับผิดชอบใน picker
- ตัวเลขทั้งหมดใน Ops (MRR, funnel ฯลฯ) และข้อความ Ops modal ที่ไม่ได้อยู่ใน Canvas เป็นข้อมูลสมมติ ไม่ใช่สัญญา

## 11. สิ่งที่ยังไม่ได้ทำ / ข้อจำกัด

- **ยังไม่ได้ทดสอบในเบราว์เซอร์** และไม่มี screenshot — ผู้สร้างไม่มีสิทธิ์รันเบราว์เซอร์ในงานนี้ · host ต้องตรวจ DOM/console/screenshot เอง (ดู `window.FM_COVERAGE`)
- ฟอนต์ IBM Plex Sans Thai ไม่ได้ฝังมา (ไม่มี network/asset) จะใช้ฟอนต์ระบบถ้าเครื่องไม่มีฟอนต์นี้
- การลากเพื่อเรียง (workflow, backlog) แสดงเป็นไอคอนจับเท่านั้น ไม่มี drag จริง · บนบอร์ดใช้ sheet "ย้าย" แทน
- สถานะ loading/empty/error ของหลายหน้าใช้แพทเทิร์นกลางของ engine (ต่างกันตามทิศทาง) ไม่ได้ออกแบบเฉพาะทุกหน้า
- กราฟเป็น SVG แบบง่าย ไม่มี tooltip/interaction
- ยังไม่ได้ทำ `ops/Abuse` (ไม่มี route)
- การ resume: ทุก batch เสร็จแล้ว ดู `progress.json`

## 12. โครงไฟล์

```
index.html, gallery.js        แกลเลอรี
inventory.json                 รายการ 189 รายการ + exclusions
progress.json                  สถานะ batch
engine/tokens.css              สำเนา token (+ ข้อเสนอ token mobile)
engine/fm.css, engine/fm.js    design engine + runtime โฟลว์
data/b1-public-auth.js         public, system, auth (19)
data/b2-workspace.js           workspace (33)
data/b3-project.js             project (43)
data/b4-issue-admin-billing-help.js  issue, admin, billing, help (45)
data/b5-ops.js                 Friday Ops (49)
```
