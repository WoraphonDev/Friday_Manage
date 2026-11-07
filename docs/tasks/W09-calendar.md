# W09 · Calendar

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A21 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/calendar/**` · `apps/web/messages/th/calendar.json` |
| หน้าจอ | 6 (`design/canvas/Calendar.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET p/calendar` (A21) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- เดือน / สัปดาห์, งาน, Sprint, วันหยุด, วันลา, ลากวางเปลี่ยน Due
- สมัคร iCal

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### หน้าและ API ที่ใช้

- `/w/[ws]/p/[key]/calendar` · `page.tsx` → `_components/calendar-view.tsx` (client) + `subscribe-dialog.tsx` + `cal.module.css` · ข้อความ `messages/th/calendar.json`
- `GET w/:ws/projects/:key/calendar?month=YYYY-MM` (A21) · ครั้งแรกไม่ส่ง `month` ให้ API เลือกเดือนนี้ตามเวลาไทย แล้วใช้ `today` / `month` ที่ตอบกลับ · cache key `["calendar", ws, key, month]`
- `GET my-permissions`: ไม่มี `issue.edit` = ลากไม่ได้ · ไม่มี `issue.create` = ซ่อนปุ่ม `+ Task` (`?new=1`) · Guest ได้ 403 `guest_view_limited` จาก API → หน้า Forbidden
- ลากวาง / Alt + ลูกศร เปลี่ยน Due: `PATCH w/:ws/issues/:key {planEnd}` + `If-Match` จาก `version` ของ calendar (ไม่มี version → `GET issues/:key` ก่อน) · 400 `plan_change_reason_required` → Dialog เหตุผลแล้วส่งซ้ำพร้อม `planChangeReason` · 403 `due_change_requires_approval` → ฟอร์ม `POST issues/:key/due-requests` · 409 → toast แล้วโหลดใหม่
- Subscribe: `GET/POST/DELETE me/calendar-feeds` · แสดง URL ครั้งเดียวหลังสร้าง พร้อมปุ่มคัดลอกและลิงก์ Google Calendar (`webcal://`) · "สร้างลิงก์ใหม่" = สร้างแล้วเพิกถอนลิงก์เดิมของโปรเจกต์นี้ · เพิกถอนรายลิงก์ได้

### คำตัดสินที่เลือกเอง / ต่างจากหน้าจอ

- ทำ Month และ Week · ไม่ทำ Day / Agenda, โหมด Start → Due, "สีตาม", Filter และคลิกวันว่างเพื่อสร้างงาน (นอกขอบเขตงานนี้) · ปุ่ม `+ Task` เปิดฟอร์มเดิมด้วย `?new=1`
- สีของงานใช้สถานะ (เลยกำหนด แดง · ครบวันนี้ เหลือง · กำลังทำ ฟ้า · ยังไม่เริ่ม เทา · Done ขีดฆ่า) แทนสี Module เพราะ API ไม่ส่ง Module · การ์ด "Module" ในหน้าจอจึงเป็นการ์ด "สัญลักษณ์" ที่มีลิงก์ Subscribe แทน
- ไม่มีการ์ด Unscheduled เพราะ calendar ไม่ส่งงานที่ไม่มีวัน
- "งานที่ Done แล้ว" ปิดเป็นค่าเริ่มต้นตาม checkbox ในหน้าจอ
- งานแสดงเฉพาะวัน Due (`planEnd`) · งานที่มีแต่ Plan Start ไม่แสดง
- ลาก Due ไปก่อน Plan Start → ส่ง `planStart` = Due ใหม่ด้วย เพื่อไม่ให้ชน `invalid_dates`
- Sprint แสดงเป็นป้าย "Sprint N เริ่ม / จบ" ที่หัววันตามหน้าจอ · Milestone เป็นแถบดำ · วันลาเป็นกรอบประ แยกครึ่งวันและ "รออนุมัติ"
- เดือนแสดง 3 รายการต่อวันแล้ว `+N more` (กดขยายในช่อง) · Week แสดงทั้งหมด · Week ใช้ข้อมูลเดือนของวัน anchor เพราะ `range` ของเดือนครอบสัปดาห์ที่คาบเกี่ยวอยู่แล้ว
- มือถือ (≤ 760 px): ชื่อวันแบบย่อ ซ่อนป้ายหัววัน ตัวอักษรรายการเล็กลง และการ์ดด้านข้างลงไปใต้ปฏิทิน

### คำขอนอก lane

- A21 (ถ้าต้องการให้ตรงหน้าจอครบ): ส่ง `moduleId` / สี Module ของงาน และรายการงาน Unscheduled ใน `GET calendar`
- ไม่มีไฟล์กลางที่ต้องแก้

### ผล test

`apps/web/src/lib/calendar.test.tsx` 10 ข้อ: เดือน (เลยกำหนด/วันนี้/Sprint/Milestone/วันหยุด/วันลา/+more/ซ่อน Done/checkbox), เลื่อนเดือนและ Today, Week, ลากวาง (If-Match, ไม่มี version, Due ก่อน Start, วันเดิม), Alt + ลูกศร, เหตุผลแก้แผนและขอเลื่อน Due, ไม่มีสิทธิ์แก้, Subscribe (สร้าง/คัดลอก/Google/สร้างใหม่/เพิกถอน), Error requestId และ 403, ตัวช่วยวันที่ · `pnpm --filter @friday/web typecheck`, `test` (157 ข้อ), `build` ผ่าน

ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440/390 px
