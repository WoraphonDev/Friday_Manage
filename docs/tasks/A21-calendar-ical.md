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

- [x] test ครอบคลุมทุกข้อ รวมไฟล์ .ics ที่ parse ได้
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/calendar/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/projects/:key/calendar?month=YYYY-MM` | `project.view` · **Guest 403 `guest_view_limited`** | ไม่ส่ง `month` = เดือนนี้ (เวลาไทย) · `range` = ช่องปฏิทินเต็มสัปดาห์ (จันทร์–อาทิตย์) ที่คาบเกี่ยวเดือน |
| POST | `me/calendar-feeds` `{ workspace, projectKey? }` | สมาชิก Workspace | คืน `url` ที่มี token (แสดงครั้งเดียว) · ไม่ส่ง `projectKey` = งานของฉันทุกโปรเจกต์ใน Workspace |
| GET | `me/calendar-feeds?workspace=` | self | รายการลิงก์ที่ยังไม่ถูกเพิกถอน (ไม่มี token เพราะเก็บเฉพาะ hash) |
| DELETE | `me/calendar-feeds/:id` | self | เพิกถอน (`revoked_at`) · ใช้ลิงก์เดิมไม่ได้ทันที |
| GET | `ical/{token}.ics` | สาธารณะ | `text/calendar` · งานของฉันที่ยังไม่เสร็จและมีวัน เป็น all-day event ช่วง Plan Start–End (ไม่มี Start = วัน Due วันเดียว) |

#### `GET calendar` ตอบ

`issues[]` (key, type, title, status, priority, planStart/End, `due` = done/overdue/today/upcoming, parentKey, assignees, **version** สำหรับ `PATCH` ลากวาง), `sprints[]`, `milestones[]`, `holidays[]` (`scope` = workspace ปฏิทินของโปรเจกต์หรือ Workspace · project = วันหยุดเฉพาะโปรเจกต์), `leaves[]` (สมาชิกโปรเจกต์รวม Owner · สถานะ pending และ approved)

### คำตัดสินที่เลือกเอง

- **Guest ได้ 403 ทั้งหน้า Calendar** ตาม 03-api 3.5 (Guest เห็นเฉพาะ Overview และ Timeline) ซึ่งทำให้กติกา "Guest ไม่เห็นวันลาและชื่อคน" ผ่านโดยปริยาย · ถ้าต้องการให้ Guest เห็นปฏิทินแบบตัดข้อมูล ต้องแก้สเปกแล้วเพิ่มโหมดนั้น
- ลิงก์ iCal ใช้ SYSTEM_DB หา token (ผู้เรียกไม่ล็อกอิน ยังไม่รู้ Workspace) แล้วอ่านงานผ่าน RLS ในฐานะเจ้าของลิงก์ จึงเห็นเท่าที่เขาเห็นได้ ณ ตอนที่แอปปฏิทินดึง (ออกจากโปรเจกต์ / ถูกปิดบัญชี Workspace → ลิงก์ใช้ไม่ได้หรืองานหาย) · Guest ในลิงก์ได้เฉพาะงานที่แชร์และไม่ใช่ Bug
- token สุ่ม 32 ไบต์ (43 ตัว base64url) เก็บ SHA-256 ในคอลัมน์ `token_hash` · `Cache-Control: private, max-age=300` และ `REFRESH-INTERVAL` 1 ชั่วโมง
- URL ใช้ `API_PUBLIC_URL` (มีอยู่แล้วใน `auth.config.ts`)
- feed ไม่รวมงานที่เสร็จแล้ว

### คำขอนอก lane

- **W09 / W17**: ลากวางเปลี่ยน Due ใช้ `PATCH issues/:key` (ส่ง `version` เป็น `If-Match`) · หน้า Profile เรียก `POST/GET/DELETE me/calendar-feeds`
- ไม่มีไฟล์กลางที่ต้องแก้

### ผล test

`apps/api/test/calendar.e2e.test.ts` 9 ข้อ: งาน (Due/ช่วงวัน/นอกช่วง/ไม่มีวัน), Sprint, Milestone, วันหยุด Workspace + โปรเจกต์, วันลา · เดือนว่าง/ค่าเริ่มต้น/รูปแบบผิด · Guest และคนนอก · สร้าง feed (เก็บแค่ hash) · ไฟล์ `.ics` ที่ parse ได้ (UID, DTSTART/DTEND exclusive, escape, folding ≤ 75 octets) · feed รายโปรเจกต์ · เพิกถอน · ออกจาก Workspace · Guest เห็นเฉพาะงานที่แชร์ · unit ของ escape/fold · `pnpm typecheck` ผ่าน
