# A25 · ส่งแจ้งเตือนออกนอกแอป: Email, Webhook และกฎของโปรเจกต์

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00, A16, A23 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/channels/**` · `apps/api/test/channels.e2e.test.ts` · `apps/api/src/core/mail.ts` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) · N2 (`design/canvas/NotifyTemplates.dc.html`) · L2 (`design/canvas/ProjectSettings.dc.html`) · I (`design/canvas/Profile.dc.html`) |
| สเปก | 03-api › 3.3 แถว `w/channels/*` · 03-api › 3.5 แถว `p/notification-rules` · 03-api › 3.9 แถว notification-templates, report-schedule |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ท่อส่ง: ทุก `notifications` ใหม่ → ตาม pref ของผู้รับและกฎของโปรเจกต์ → `notification_delivery` → งานในคิว (retry, ช่วงงดส่ง, Safe mode ส่งแค่หัวข้อ + ลิงก์, Bug Critical ข้ามช่วงงดส่ง) · interface `ChannelSender` ให้ LINE (A24) ต่อเพิ่ม
- Email: SMTP (nodemailer) จาก `email_sender_config` หรือ env · ใส่ใน `Mailer` (`core/mail.ts`)
- Webhook ทั่วไป + รูปแบบ Discord / Slack / Teams / Telegram · `CRUD w/channels/webhooks` + `:test` · ลายเซ็น HMAC
- `GET / PUT p/notification-rules`, `p/notification-settings` · `GET w/channels/deliveries` · `GET w/notification-templates/{event}:preview?channel=` (N2)
- `GET / PUT p/report-schedule` · `POST p/reports/weekly:send` (ใช้ข้อมูลจาก A09 ถ้า merge แล้ว)

## กติกาที่ต้องตรง

- secret เข้ารหัสก่อนเก็บ · ตอบกลับเฉพาะ 4 ตัวท้าย

## เสร็จเมื่อ

- [ ] test ด้วย SMTP / webhook ปลอม: ส่งตาม pref, retry เมื่อปลายทางล้ม, ช่วงงดส่งเลื่อนเวลาส่ง
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- LINE (A24)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
