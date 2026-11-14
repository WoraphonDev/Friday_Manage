# HANDOFF · Friday Mobile — ดีไซน์ที่เลือก (Unified)

> ต้นแบบสำหรับพรีวิวเท่านั้น · ไม่แตะ repo `Friday_Manage` · ไม่ deploy · ไม่มี API · ข้อมูลสมมติชุดเดิม · desktop ไม่ถูกแตะ

## ทิศทางที่รวม
ระบบเดียว ไม่ใช่สลับ 3 skin:
- **B Calm Cards = ฐาน**: หัวหน้า (หัวข้อใหญ่), แถบล่าง pill, เมนูย่อย "มุมมอง ▾", การ์ด, หัวข้อส่วน, token/ปุ่ม/ระยะ — ใช้ทุกหน้า · เนื้อหา B สำหรับ Home, Projects, Profile/ตั้งค่า, แดชบอร์ด, บอร์ด, ไทม์ไลน์, ปฏิทิน, เมนูและแผง (action sheet / ครึ่งจอ)
- **A ความหนาแน่น**: My Tasks, Inbox, สมาชิก, ตาราง, รายการ Ops — แถวกระชับ แต่วางในกลุ่มขอบมนของ B
- **C การกระทำตามบริบท**: รายละเอียดงาน, สร้าง/แก้ไข, ฟอร์ม, sheet, ยืนยัน — การ์ดบริบท + ปุ่มหลักใหญ่ล่างจอ · แถบบริบทของ C ปรับเป็นโทนสว่าง ไม่มี dock เข้ม
กฎเต็มดู `CHOICES.json` · ราย ID ฉบับเต็มคำนวณตอนรัน: `window.FM_UNIFIED.choices`

## ไฟล์ (โฟลเดอร์นี้)
`/Users/mickitang/.hermes/profiles/friday/cache/scratch/claude-friday-mobile-selected/`
- `index.html` — แอปพรีวิว: กรอบมือถือเดียว + แผง "โฟลว์หลัก" 9 โฟลว์ + "Design navigator" ทุกหน้า (กรองโมดูล/ฐาน/ค้นหา) + แผงขวา (ฐานที่เลือก, เหตุผล, การปรับ, ไฟล์ต้นทาง, ลิงก์ไปต้นฉบับ A/B/C) · ลิงก์ถาวร `#/<id>/<state>?w=390`
- `unified.js` — ตัวประกอบหน้า (เนื้อหาฐานที่เลือก + chrome B) และ runtime โฟลว์
- `unified.css` — style ร่วม (scoped ใต้ `.app.uni`) + เปลือกพรีวิว
- `unified-data.js` — หน้าเพิ่ม 3 หน้า + การปรับข้อมูลในหน่วยความจำ
- `CHOICES.json`, `HANDOFF.md`

**Dependency (อ้างแบบ relative ไม่ได้ copy):** `../claude-friday-mobile-complete/` → `engine/tokens.css`, `engine/fm.css`, `engine/fm.js`, `data/b1…b5*.js`, `inventory.json` · ต้องเสิร์ฟโฟลเดอร์แม่ `scratch/` ผ่าน HTTP · แกลเลอรี ABC เดิมไม่ถูกแก้แม้แต่ไฟล์เดียว

## Coverage
- inventory เดิม **189** รายการ ยังเข้าถึงได้ครบใน navigator (ไม่มีรายการหาย; ถ้า render ไม่ได้ จะขึ้น `!` และนับใน `FM_UNIFIED.missing`)
- เพิ่มใหม่ **3**: `u.projects` (รายการโปรเจกต์ ปลายทางแท็บโปรเจกต์), `u.iss-edit` (sheet แก้ไขงาน), `ops.abuse` (**canvas-only**, จาก `design/canvas/ops/Abuse.dc.html`, ไม่มี route/สัญญา API)
- รวม **192** · จำนวนตามฐาน A/B/C แสดงบนหัวแผงซ้ายและใน `window.FM_UNIFIED.byBase`
- การปรับข้อมูลเดิม (ในหน่วยความจำเท่านั้น): FAB สร้างงานบน `ws.home` · ปุ่ม/เมนู "แก้ไขงาน" ใน `iss.detail`, `iss.more` · ทางเข้า Abuse ใน `ops.menu` · แท็บโปรเจกต์ → `u.projects`

## โฟลว์ที่กดต่อกันได้
หน้าหลัก→งาน→แก้ไข→บันทึก · สร้างงาน (FAB→sheet→สำเร็จ) · งานของฉัน→ตัวกรอง/รายละเอียด/ขอเลื่อน · กล่องข้อความ→อนุมัติเลื่อน/กิจกรรม · แท็บโปรเจกต์→ภาพรวม→มุมมอง · ลบงาน (เมนู→ยืนยัน→toast เลิกทำ) · สลับ Workspace · โปรไฟล์/ความปลอดภัย · Ops Abuse→ระงับ · ทุกหน้ามีตัวสลับสถานะ (default/loading/empty/error/success ฯลฯ) ตาม inventory

## ทำแล้ว / ยังไม่ได้ทำ (ตรงไปตรงมา)
- ทำแล้ว: chrome เดียว (หัว/แถบล่าง/เมนูย่อย) ทุกหน้า, การเลือกฐานแบบมีกฎ, popup วางบนหน้าแม่ที่ unified แล้ว, หน้าเพิ่ม 3 หน้า
- **ยังไม่ได้**: ขัดเกลาระดับพิกเซลรายหน้า — เนื้อหาเกือบทั้งหมดยังเป็น layout ที่ engine เดิม generate ตามฐานที่เลือก · ยังไม่ได้ทดสอบในเบราว์เซอร์ (ไม่มีสิทธิ์รัน) · การประกอบใช้การตัดต่อ HTML (regex หัว/nav) ถ้า engine เดิมเปลี่ยน markup ต้องปรับ `unified.js` · หน้า C บางหน้าอาจยังมีระยะล่างเผื่อ dock เดิม · `CHOICES.json` เป็นกฎ ไม่ได้แจกแจง 192 ID ด้วยมือ
- ไม่มีสัญญา production ใหม่: `u.*` เป็นข้อเสนอ, `ops.abuse` canvas-only

## การคง desktop
ไม่แก้ desktop/production ใดๆ · เมื่อ implement จริงให้ทำใน `@media (max-width:760px)` / `useMobile()` ตาม HANDOFF เดิมข้อ 6–7 (รวมแก้ 767→760 ใน issue-drawer) และถ่าย baseline desktop 1280/1440/1920 ก่อน merge
