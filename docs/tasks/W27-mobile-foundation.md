# W27 · เว็บมือถือ: ฐานร่วม (Mobile foundation)

| | |
|---|---|
| Wave | มือถือ-1 · ผู้ใช้สั่งเริ่ม 15 พ.ย. 2569 |
| รอ merge | — |
| Lane (แก้ได้เฉพาะ) | `apps/web/src/styles/tokens.css` (เพิ่ม token มือถือ) · `apps/web/src/styles/globals.css` (ต่อท้ายเท่านั้น ใน `@media (max-width: 760px)`) · `apps/web/src/components/ui/overlays.tsx` (`ActionSheet`) · `apps/web/src/components/shell/workspace-shell.tsx` (เฉพาะ `mobile-bottom-nav`) · เส้นแบ่ง 767→760 ใน `issue-drawer.module.css` และ `board/_components/kanban.module.css` |
| หน้าจอ | `docs/prototypes/mobile/claude-friday-mobile-selected` (แบบที่ผู้ใช้เลือก) · กฎใน `CHOICES.json` · แผน PR ใน `claude-friday-mobile-complete/HANDOFF.md` ข้อ 9 |
| สเปก | — (ไม่เปลี่ยน API) |

อ่าน [README](README.md) ก่อนเริ่ม · งานนี้เป็นฐานของงานมือถือที่เหลือ (Auth, Workspace core, Issue drawer, Project views ฯลฯ ตาม HANDOFF ข้อ 9) จึงแตะไฟล์กลางของ W00 แบบเพิ่มอย่างเดียว

## ผู้ใช้ตัดสินแล้ว (15 พ.ย. 2569)

- หน้ามือถือ (≤760px) ยึดต้นแบบ `docs/prototypes/mobile` แทน Canvas `Mobile*.dc.html` (UI v1.0.3) · desktop ยังยึด Canvas เดิม
- **ห้ามกระทบ desktop เด็ดขาด:** style ใหม่อยู่ใน `@media (max-width: 760px)` หรือ component ที่ mount เมื่อ `useIsMobile()` · ไม่แก้ selector/ค่า token ของ desktop · ทุก PR มือถือเทียบภาพ desktop ก่อน/หลัง
- ข้อเสนอที่ยังไม่มีสัญญา API (ปัดแถวงาน, ชิปสถานะถัดไป, +1/+3 วัน, Ops Abuse) ไม่อยู่ในงานนี้

## ทำอะไร

- Token มือถือ `--m-tap` 44px · `--m-text-body` 15px · `--m-text-input` 16px · `--m-radius-sheet` 16px (ไม่ใช่สี จึงไม่ต้องมีค่าโหมดมืด)
- เมนูล่างแบบ B: ไอคอนอยู่ในแคปซูล `--primary-soft` เมื่อเป็นหน้าปัจจุบัน · 5 แท็บพอดีจอ 320px (ป้ายตัดด้วย … แทนการล้น)
- Dialog ทุกขนาด (`Dialog`, `ConfirmDialog`, `size="medium" | "wide"`) บนมือถือเป็น bottom sheet: ชิดล่าง มุมบนโค้ง มีที่จับ เว้น safe-area · ปุ่มหลักเต็มความกว้างอยู่ล่าง
- `ActionSheet` ใน `components/ui`: รายการคำสั่ง (ไอคอน · คำอธิบายท้ายแถว · ลบ = สีอันตราย · ปิดใช้ได้) + ปุ่มยกเลิกแยก · สำหรับงานถัดไปใช้แทนเมนู popover บนมือถือ
- ช่องกรอกบนมือถือตัวอักษร 16px กัน iOS ซูม
- เส้นแบ่งมือถือค่าเดียว 760px (เดิม drawer / kanban ใช้ 767px) + test กันค่าอื่นกลับเข้ามา

## เสร็จเมื่อ

- [x] ภาพ desktop 1280 / 1440 / 1920 (สว่าง + มืด) และ 768 ของหน้าหลัก 13 หน้าเหมือนก่อนแก้ทุกพิกเซล (ยกเว้นนาฬิกาที่เดินเอง ดูบันทึกผล)
- [x] มือถือ 320 / 390: เมนูล่างไม่ล้น · Dialog เป็น bottom sheet · ไม่มี scroll แนวนอน
- [x] test: `ActionSheet` · เส้นแบ่ง 760px · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] build และ deploy Docker เว็บในเครื่องตาม CLAUDE.md

## บันทึกผล

ส่งงาน 15 พ.ย. 2569 · ไม่เปลี่ยน API

**สิ่งที่ทำ**
- `tokens.css`: `--m-tap` / `--m-text-body` / `--m-text-input` / `--m-radius-sheet` (ไม่ใช่สี `theme.test` จึงไม่บังคับค่าโหมดมืด)
- `globals.css` ต่อท้ายไฟล์: กฎทั้งหมดอยู่ใน `@media (max-width: 760px)` · class ใหม่นอก media (`.action-sheet-*`) ไม่มีหน้า desktop ใช้ · `@keyframes sheet-up` เป็นแค่นิยาม
- เมนูล่าง: ห่อไอคอน / ป้ายด้วย `.bottom-nav-icon` / `.bottom-nav-label` ใน `workspace-shell.tsx` (nav นี้ `display:none` บน desktop) · ชื่อปุ่มสำหรับโปรแกรมอ่านหน้าจอเท่าเดิม
- Dialog มือถือ = bottom sheet + ที่จับ (`::before`) + เว้น `env(safe-area-inset-bottom)` · `dialog-actions` เรียงปุ่มหลักไว้ล่างเต็มความกว้าง · `plan-io` มี `.dialog` ของ CSS module เอง (ชื่อ hash) จึงไม่โดน
- `ActionSheet` + `ActionSheetAction` export จาก `@/components/ui` · ยังไม่มีหน้าใดใช้ (งานมือถือถัดไปใช้แทนเมนู popover เมื่อ `useIsMobile()`)
- 767 → 760: `issue-drawer.module.css` 2 จุด · `kanban.module.css` 1 จุด

**ผลต่อจอ 761–767px:** เดิม drawer / บอร์ดเป็นแบบมือถือขณะที่ shell (sidebar) เป็น desktop · ตอนนี้ทั้งหน้าเป็น desktop เหมือนจอ 768 · จอ ≥768 ไม่เปลี่ยน

**ตรวจภาพก่อน/หลัง** (Playwright + Chrome ในเครื่อง · บัญชีทดสอบ `ui-mw5wjqwb` · ก่อน = image `fb4d8c71fdf5` จาก main 4c8877f)
- 13 หน้า: landing · pricing · login · home · my-tasks · inbox · overview · board · table · drawer (`?issue=DEMO-1`) · create (`?new=1`) · profile · admin
- desktop 1280 / 1440 / 1920 สว่าง + มืด และ 768: ต่างเฉพาะ overview / create / profile กล่องประมาณ 12×8 px ตำแหน่งเดียวกับการถ่าย "ก่อน" สองรอบที่เทียบกันเอง = เลขนาทีของนาฬิกา (อัปเดตล่าสุด HH:MM / เวลาเครื่อง GMT+7) · ส่วนอื่นเหมือนกันทุกพิกเซล
- 761: board / create / drawer เปลี่ยนเป็น desktop ตามเส้นแบ่งใหม่
- มือถือ 320 / 390: ทุกหน้าเปลี่ยนเฉพาะเมนูล่าง (แคปซูล) และช่องกรอก 16px · ไม่มี scroll แนวนอน · 5 แท็บพอดีจอ 320
- Dialog จริง (เชิญสมาชิก `size="medium"`): 390 / 320 ชิดล่างเต็มกว้าง มุมบน 16px ช่องกรอก 16px · 1280 อยู่กลางจอ 680px มุม 12px ช่องกรอก 13px เหมือนเดิม

**ยังไม่ได้ทำ (งานถัดไป)**
- `viewport-fit=cover` ยังไม่ใส่: จะทำให้ iPhone แนวนอน (กว้าง >760 ได้ layout desktop) มีเนื้อหาใต้รอยบาก จึงรอทำพร้อมการตัดสินใจเรื่องแนวนอน (HANDOFF ข้อ 6)
- ขนาดตัวอักษร 15px และปุ่ม 44px ทั้งหน้า: มี token แล้ว ใช้ในงานแต่ละโมดูลเพื่อไม่ให้ layout มือถือที่มีอยู่เพี้ยนพร้อมกันทุกหน้า
- เมนูล่างแท็บโปรเจกต์ยังเปิดเมนู ☰ (ต้นแบบไปหน้า `u.projects`) → งาน Workspace core
