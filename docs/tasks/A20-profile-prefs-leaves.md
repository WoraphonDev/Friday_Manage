# A20 · Profile, การตั้งค่าแจ้งเตือนของฉัน และวันลา

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/me/**` · `apps/api/test/profile.e2e.test.ts` |
| หน้าจอ | I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 3.1 แถว `me` · 03-api › 3.2 แถว `w/me/membership`, `w/leaves` · 03-api › 3.9 แถว `me/notification-prefs` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `PATCH me` (ชื่อ, ภาษา, ปี พ.ศ. / ค.ศ., timezone) · `GET / PATCH w/me/membership` (ตำแหน่ง, แผนก, capacity, เวลาทำงาน)
- `GET / PUT me/notification-prefs` (ตารางเหตุการณ์ × ช่องทาง ต่อ Workspace) · `GET / PUT me/notification-settings` (เตือนก่อนครบกำหนด, digest, ช่วงงดส่ง, Auto-watch)
- `GET / POST / DELETE w/leaves` (ของคนอื่น: `ws.members.manage`) · เพิ่ม Event `leave.created` ต่อท้าย `EventType` ใน `core/events.ts`

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ผูก LINE (A24)
- iCal (A21)
- 2FA / Session (A13)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/me/`)

| Method | Path | หมายเหตุ |
|---|---|---|
| PATCH | `me` | `displayName`, `firstName`, `lastName`, `phone`, `about`, `avatarUrl`, `locale` (th/en), `yearFormat` (BE/CE), `timezone` (ตรวจ IANA) · `GET me` เพิ่มฟิลด์ชุดเดียวกัน |
| GET / PATCH | `w/:ws/me/membership` | `jobTitle`, `department`, `capacityHoursWeek` 0–80, `workStart` / `workEnd` (ต้องคู่กันและเลิกหลังเริ่ม), `workDays` (1–7) · `null` = ใช้เวลาทำงานของ Workspace · ตอบ `effective` ที่ใช้จริง |
| GET / PUT | `me/notification-prefs?workspace=` · body `{ workspace, prefs:[{eventType, channel, enabled}], reset? }` | ตารางเหตุการณ์ × ช่องทาง (`in_app` · `email` · `line`) 20 แถว · upsert เฉพาะที่ส่ง · `reset: true` ล้างกลับค่าเริ่มต้น · ตอบเมทริกซ์เต็มพร้อม `locked` (In-app ที่ปิดไม่ได้) และ `custom` (ผู้ใช้ตั้งเอง) |
| GET / PUT | `me/notification-settings?workspace=` · body `{ workspace, dueReminder?, digest?, quietStart?, quietEnd?, quietOnHolidays?, autoWatch? }` | บางส่วนได้ · `quietStart`/`quietEnd` ต้องคู่กัน (null ทั้งคู่ = ไม่งดส่ง) |
| GET / POST / DELETE | `w/:ws/leaves` · `/:id` | GET `?user=` (ไม่ส่ง = ของฉัน · `all` / userId = Admin), `from`, `to` · POST `{ leaveType, startDate, endDate, halfDay?, userId? }` · ลาเอง = `pending` · Admin ลงให้ = `approved` |
| POST | `w/:ws/leaves/:id/approve` (และ `:approve`) | Owner / Admin · เพิ่มเอง เพราะสเปกให้สถานะ "รออนุมัติ" แต่ไม่มีทางอนุมัติ |

### กติกา

- **ตารางแจ้งเตือน**: แหล่งเดียวที่ `me/prefs-catalog.ts` · ค่าเริ่มต้น Email = `EMAIL_DEFAULT_ON` ของ A25, In-app เปิดทุกแถว (ปิดเฉพาะ `digest.daily`) และล็อกตาม `IN_APP_LOCKED` ของ A23 (มอบหมาย, Review, @mention, คำขอเลื่อน Due, เลยกำหนด, ถูกเพิ่มเข้าโปรเจกต์) — PUT ปิดแถวที่ล็อก → 400 `locked_channel` · LINE ตามคอลัมน์ LINE ของ Canvas I
- **ค่าเริ่มต้นของ `notification-settings`** = งดส่ง 20:00–08:00 + วันหยุด (ตรงกับที่ `ChannelDispatcher` ใช้เมื่อไม่มีแถว) · `custom: false` ถ้ายังไม่เคยบันทึก
- **วันลา**: ซ้อนกับวันลาเดิมของคนเดียวกันไม่ได้ (409 `leave_overlap`) ยกเว้นครึ่งวันเช้า/บ่ายของวันเดียวกัน · ครึ่งวันต้องเป็นวันเดียว · Guest ลาไม่ได้ · วันลาที่มาจากระบบ HR (`source = hr`) ลบไม่ได้ (403 `leave_from_hr`)
- **Event `leave.created`**: เพิ่มต่อท้าย `EventType` ใน `core/events.ts` · ส่งหลัง commit พร้อม `affectedIssues` · และแจ้ง (`Notifier`, eventType `leave.created`) ผู้สร้างงาน + PM ของงานที่ผู้ลาเป็น Assignee และยังไม่เสร็จ ซึ่งช่วงงานทับวันลา (รวมเป็น 1 แจ้งเตือนต่อโปรเจกต์ มี `issueKeys`/`issueCount`)

### คำตัดสินที่เลือกเอง

- **เขียน `users` และ `workspace_members` ของตัวเองด้วย SYSTEM_DB** (ล็อก id ผู้เรียก / Workspace + ฟิลด์ที่ผ่าน schema เท่านั้น) เพราะ RLS ไม่ให้สมาชิกแก้แถวตัวเอง (กันแก้ role / status) — ตอนแรกลองผ่าน RLS แล้วอัปเดตเงียบโดยไม่มีผล
- ค่า LINE ในตารางเป็น "ค่าเริ่มต้นที่แสดง" เท่านั้น: ตัวส่งของ A25 รู้เฉพาะค่าเริ่มต้นของ Email ผู้ใช้ที่ไม่เคยกดบันทึกจึงไม่ได้ LINE ตามค่าที่เห็น · หน้าเว็บควรส่ง `PUT` ทั้งเมทริกซ์เมื่อผู้ใช้กดบันทึกครั้งแรก (ดูคำขอนอก lane ที่ A25)
- ลาเอง = รออนุมัติ (ตาม Canvas I) จึงเพิ่ม `approve` ให้ Admin · วันลาที่ยังรออนุมัติถูกนับใน Workload แล้ว (A08)
- ไม่ทำ: ผูก LINE (A24), iCal (A21), 2FA / Session (A13)

### คำขอนอก lane

- **A25** (`channels/dispatcher.ts`): ให้ `ChannelSender` มี `defaultOn?(eventType)` แล้วใช้ค่าเดียวกับ `LINE` ใน `me/prefs-catalog.ts` (ซ้ำกับคำขอของ A24) จะได้ค่าเริ่มต้นที่แสดงตรงกับที่ส่งจริง
- **A23**: `digest.daily` Email ต้องถูกสร้างแม้ In-app ปิด (ค่าเริ่มต้นของ Canvas I) · A23 ยังสร้างเฉพาะเมื่อเปิด In-app
- **W17**: ใช้ `GET me` + `PATCH me` + endpoint ข้างบน · ผูก LINE ใช้ `me/line/*` (A24) · iCal ใช้ `me/calendar-feeds` (A21)

### ผล test

`apps/api/test/profile.e2e.test.ts` 14 ข้อ: PATCH me (ทุกฟิลด์, ตรวจข้อมูล, แก้ของคนอื่นไม่ได้) · membership (ค่าเริ่มต้น/effective, dedupe + เรียง `workDays`, reset เป็น null, ตรวจเวลา/Capacity) · prefs (ค่าเริ่มต้นตาม Canvas, upsert ไม่ซ้ำ, แยกรายคน, In-app ที่ล็อก, event/ช่องทางที่ไม่รู้จัก, reset, คนนอก 404) · settings (ค่าเริ่มต้นตรงกับตัวส่ง, บางส่วน, ช่วงงดส่ง) · leaves (ลาเอง/ซ้อน/ครึ่งวัน/ตรวจข้อมูล/Guest/Admin ลงให้/อนุมัติ/ลบ/HR) · Event + แจ้งผู้สร้างงานที่ทับช่วงลา · API ทั้งชุด 381 ผ่าน · `pnpm typecheck` ผ่าน
