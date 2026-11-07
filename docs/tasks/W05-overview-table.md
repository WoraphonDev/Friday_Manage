# W05 · Overview และ Table ของโปรเจกต์

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A03, A08 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/page.tsx` · `apps/web/app/w/[ws]/p/[key]/table/**` · `apps/web/messages/th/overview-table.json` |
| หน้าจอ | 1 (`design/canvas/Main.dc.html`) · 2 (`design/canvas/Table.dc.html`) · M6 (`design/canvas/MobileOverview.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 2 หน้า 1, 2 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Overview ตามหน้าจอ (Health, KPI, Milestone, Burn-up, Workload สัปดาห์นี้)
- Table: Module › Task › Sub-task, ตัวกรองทั้งหมด, แก้ในแถว, เลือกหลายแถว (bulk), Saved view (ถ้า A22 merge แล้ว), virtualized สำหรับ 300+ แถว

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม

| Route | ใช้ API | หมายเหตุ |
|---|---|---|
| `/w/[ws]/p/[key]` (Overview · 1 / M6) | `GET p/overview?scope=all\|mine&moduleId=` | มุมมองทั้งโปรเจกต์ / งานของฉัน + กรอง Module · การ์ดบน 5 ใบ (ความคืบหน้างาน + Man-Day, เวลาที่ผ่านไป, % เสร็จ, วันทำการที่เหลือ + งานสุดท้าย, Milestone ถัดไป) · แถบ Health (ช้ากว่าแผน, Overdue + คนที่ค้างมากสุด, capacity ต้องใช้ vs มี, แผน vs ทำจริง) · KPI 4 ช่องที่กดแล้วเปลี่ยนรายการด้านล่าง + ลิงก์ "เปิดใน Table" (Overdue → `table?overdue=true`) · กราฟ Done รายวัน / Burn-up (แผน vs ทำจริง, SVG) · ข้อมูลโปรเจกต์ (เป้าหมาย, In/Out-of-scope, Lead, ลูกค้า) · Progress by Module · Status breakdown · Milestones · Workload สัปดาห์นี้ (ไม่มีเมื่อ Guest) · Recent activity |
| `/w/[ws]/p/[key]/table` (Table · 2) | `GET p/issues?view=table&limit=500` (โหลดต่อด้วย `cursor` สูงสุด 2,000 แถว) · `GET p/form-options` · `PATCH issues/:key` (If-Match) · `POST p/issues/bulk` · `GET/POST/DELETE p/saved-views` · `GET p/my-permissions` | Module › กลุ่มงาน › Task › Sub-task (Sub-task ต่อท้ายแม่) พร้อมสรุปต่อ Module · ย่อ / ขยายรายกลุ่ม, Expand all / Collapse all · ตัวกรอง: ค้นหา, หมวดสถานะ, Dev (ทุกคน / ฉัน / ไม่มี / รายคน), Priority, ระดับ, Overdue, แสดงงานที่เสร็จ (ปิด = `status=todo,in_progress`) · **แก้ในแถว** Status / Priority / Plan End (หลัง Baseline ถามเหตุผลแล้วส่งซ้ำพร้อม `planChangeReason`) · **เลือกหลายแถว**: ย้าย Module / Due / Assignee และ Delete (ต้องพิมพ์ "ลบ N งาน" ตามกติกา API) · **Saved view** บันทึกตัวกรองปัจจุบัน (ส่วนตัวหรือแชร์) เลือก / ลบได้ · **virtualized** เมื่อเกิน 300 แถว (render เฉพาะแถวในจอ + spacer) · ไม่มี `issue.edit` = ไม่มีช่องเลือก / ช่องแก้ · Guest = 403 |

### คำตัดสินที่เลือกเอง / ต่างจาก Canvas

- ไม่ได้ทำใน Table: ลากแถวเรียงลำดับ / ย้ายข้าม Module, ดับเบิลคลิกเปลี่ยนชื่อ Module, `+ Module` / `+ Task` ในตาราง, เลือก Columns, Group by แบบอื่น (Status / Assignee / Priority), ตัวกรอง BA / Size, ปุ่ม Import / Export Excel (W14) · ช่อง FR / Screen ไม่แสดง (API table ยังไม่ส่ง)
- Overview: ปุ่ม "แก้ไข" ข้อมูลโปรเจกต์และ Invite อยู่ใน Project Settings / shell · เอกสาร (SRS, BRD) ยังไม่มีใน API
- ลิงก์ชื่องานใช้ `?issue=KEY` บน route ปัจจุบัน (Drawer ของ project layout)
- **แก้ไฟล์กลาง `src/i18n/messages.ts`**: ใส่ namespace `inbox-bell` เพราะกระดิ่ง (W04) อยู่ใน shell ทุกหน้า ไม่งั้น test ที่ render shell จะ log `MISSING_MESSAGE`

### คำขอนอก lane

- **A03**: table response ควรมี FR / Screen, ลำดับ manual (`rank`) ต่อ Module และ endpoint เปลี่ยนชื่อ Module สำหรับดับเบิลคลิก
- **A08**: ส่ง `documents` (SRS / BRD / ไฟล์แผน) ในข้อมูลโปรเจกต์ของ Overview

### ผล test / ตรวจ

`src/lib/overview-table.test.tsx` 10 ข้อ (MSW): Overview ทุกส่วน + สลับ KPI + Burn-up, scope / Module ส่ง query, Error + requestId / 403 · Table โครง Module › Task › Sub-task + ย่อ / ขยาย + ตัวกรองทุกตัว (รวม `?overdue=true` จาก Overview), แก้ในแถว + If-Match + เหตุผล Baseline, bulk (Module + Delete พร้อมพิมพ์ยืนยัน), ไม่มีสิทธิ์ / Guest, Saved view, 450 แถว virtualized + เลื่อนแล้ว render แถวใหม่, ว่าง, Error, `buildDisplay` · `pnpm --filter @friday/web typecheck test build` ผ่าน (web 137 test)

**ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px**

### แก้ UX จากการตรวจ Canvas — 2026-11-07

- ตามคำสั่งผู้ใช้ให้แก้ขั้นตอนที่ไม่สมเหตุสมผล: เพิ่ม/เปลี่ยนชื่อ Module และกลุ่มงานใน Table; กลุ่มว่างแสดงได้ และเลื่อนไปกลุ่มใหม่แม้มี 450 แถว
- +Task ส่งบริบท Module/Phase ไป Drawer; แยกร่างแต่ละกลุ่ม; สร้างแล้วรีเฟรชรายการและล้าง query บริบทเมื่อปิด; เพิ่ม Views Sprint/Backlog ที่ API รองรับ
- เพิ่มกลุ่มใหม่เปลี่ยนเป็น All tasks เพื่อให้เห็นกลุ่มที่ยังไม่มีงานตรงตัวกรองเดิม; การเปลี่ยนชื่อไม่ล้างตัวกรอง
- คำขอนอก lane ที่ผู้ใช้อนุญาตแล้ว: W02 รับบริบท/QA/M4, W00 ApiClient ใช้ no-store กัน ETag เดิมคืนข้อมูลเก่าและปรับเมนูมือถือ, W06 สถานะจากคอลัมน์, W07 เพิ่ม Milestone ในหน้าเดิม, W14 ผลตรวจมือถือ
- [รายงานและภาพ](../reviews/ui-ux-review-2026-11-07.md): web 436 tests และ browser workflow 15/15 ผ่าน; visual checkbox ยังไม่ติ๊กเพราะ FR/Screen และฟิลด์อ้างอิงยังไม่ครบ

### แก้ในแถวของ Table — 2026-11-07

- ตามคำขอผู้ใช้: แก้ Dev (หลายคน ส่งครั้งเดียวตอนปิด), BA, Size · Man-Day, Plan Start, Plan End และ Actual Start ได้จากแถว · ชี้แถวแล้วเห็นกรอบจางทุกช่องที่แก้ได้
- ปุ่ม + Sub-task โผล่เมื่อชี้แถว Task · พิมพ์ชื่อแล้ว Enter สร้างต่อเนื่องได้ · ประเภทงานที่บังคับฟิลด์เพิ่มจะเปิดฟอร์มเต็มแทน
- **ต่างจากสเปก** `01-entities.md` ข้อ 9: ผู้ใช้ให้ Actual Start แก้เองได้ (ระบบยังตั้งให้อัตโนมัติเมื่อเริ่มทำ) · Actual End ยังตั้งจากสถานะ Done เท่านั้น · ห้ามเกินวันนี้หรือหลัง Actual End · บันทึกใน Activity
- คำขอนอก lane: A03 `PatchIssueBody.actualStart` + test ใน `issues.e2e.test.ts` + OpenAPI · D99 ปรับข้อ 9 ของ `01-entities.md` ตามข้อข้างบน
