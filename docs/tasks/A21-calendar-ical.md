# A21 · ปฏิทินโปรเจกต์ และ iCal

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/calendar/**` · `apps/api/test/calendar.e2e.test.ts` |
| หน้าจอ | 6 (`design/canvas/Calendar.dc.html`) · I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 2 หน้า 6 · 03-api › 3.1 แถว `me/calendar-feeds` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/calendar?month=YYYY-MM`: งาน (Due และช่วงวัน), Sprint, วันหยุด (Workspace + โปรเจกต์), วันลาของสมาชิก
- `POST / DELETE me/calendar-feeds` ได้ URL iCal ที่มี token · `GET ical/{token}.ics` (สาธารณะ) = งานของฉันทุกโปรเจกต์

## กติกาที่ต้องตรง

- Guest ที่เป็น Viewer ไม่เห็นวันลาและชื่อคน

## เสร็จเมื่อ

- [ ] test ครอบคลุมทุกข้อ รวมไฟล์ .ics ที่ parse ได้
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
