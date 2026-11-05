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

- [ ] test ครอบคลุมทุกข้อ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ผูก LINE (A24)
- iCal (A21)
- 2FA / Session (A13)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
