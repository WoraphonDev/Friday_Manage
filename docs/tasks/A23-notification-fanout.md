# A23 · กระจายแจ้งเตือนจาก Event และแจ้งเตือนตามเวลา

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/notifications/**` · `apps/api/test/notification-fanout.e2e.test.ts` |
| หน้าจอ | G (`design/canvas/Inbox.dc.html`) · K4 (`design/canvas/Bell.dc.html`) · I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › Event ที่ระบบส่งต่อ (คอลัมน์ "ส่งหาใคร") · 03-api › 3.9 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ฟัง `EventBus` ทุก Event ในตาราง แล้วสร้าง `notifications` ผ่าน `Notifier` ตามผู้รับเริ่มต้น · ตัดผู้ทำเอง · เคารพ `user_notification_pref` (ช่องทาง in_app) · ใส่ `reason`
- `issue.status_changed` ที่สถานะปลายทางชื่อ Review → แจ้ง Reviewer เป็น `issue.review_requested`
- งานตามเวลา (A16): `issue.due_soon` ตาม `due_reminder` ของแต่ละคน 08:00 · สรุปงานเลยกำหนดให้ Lead 09:30 วันทำการ · digest
- `due_request.*` และ `project.admin_joined` ส่งอยู่แล้ว: อย่าส่งซ้ำ

## เสร็จเมื่อ

- [ ] test: ทุก Event ในตารางได้ผู้รับตรงตามคอลัมน์ "ส่งหาใคร" · ปิด pref แล้วไม่ได้รับ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งออกนอกแอป (A24, A25)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
