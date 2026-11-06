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

- [x] test ด้วย SMTP / webhook ปลอม: ส่งตาม pref, retry เมื่อปลายทางล้ม, ช่วงงดส่งเลื่อนเวลาส่ง
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- LINE (A24)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/channels/`) · Owner / Admin (`ws.settings`) ทุกข้อ ยกเว้นที่ระบุ

| Method | Path | หมายเหตุ |
|---|---|---|
| GET / PUT | `w/:ws/channels/email` | PUT เปลี่ยนโดเมนผู้ส่งหรือ SMTP → ล้างผลตรวจ DNS · รหัสผ่าน SMTP ตอบกลับเฉพาะ 4 ตัวท้าย (`smtpPasswordLast4`) |
| POST | `w/:ws/channels/email/verify-dns` (และ `email:verify-dns`) | SPF ที่โดเมน · DKIM ที่ `friday._domainkey.<โดเมน>` · DMARC ที่ `_dmarc.<โดเมน>` · ผ่านครบจึงตั้ง `verifiedAt` |
| POST | `w/:ws/channels/email/test` (และ `email:test`) | ส่งอีเมลทดสอบถึงผู้เรียก · ล้ม 502 `email_send_failed` |
| GET / POST | `w/:ws/channels/webhooks` | URL / secret เข้ารหัส (AES-256-GCM) ตอบกลับ `urlLast4`, `signingSecretLast4` · `generateSecret: true` ให้ระบบสร้าง secret และแสดงค่าเต็ม **ครั้งเดียว** ในคำตอบของ POST |
| PATCH / DELETE | `w/:ws/channels/webhooks/:id` | PATCH `status: "active"` เปิด Webhook ที่ถูกปิดชั่วคราวกลับมา (ล้าง `consecutiveFailures`) |
| POST | `w/:ws/channels/webhooks/:id/test` (และ `:id:test`) | ส่งข้อความตัวอย่างทันที ไม่ผ่านคิว · ล้ม 502 `webhook_test_failed` |
| GET | `w/:ws/channels/deliveries?status=&channel=&limit=&before=` | แบ่งหน้าด้วย `before` (createdAt ของรายการสุดท้าย) → `nextCursor` |
| GET | `w/:ws/notification-templates/:event/preview?channel=email、webhook、line&format=&safe=` | N2 · ข้อมูลตัวอย่างสมมติ · `safe` ไม่ส่ง = ตามค่า Workspace |
| GET / PUT | `w/:ws/projects/:key/notification-rules` | PUT แทนที่ทั้งชุด · อ่าน `project.view` (Guest ไม่ได้) แก้ `project.settings` · คืน `targets` (Webhook / LINE กลุ่มที่เลือกได้) ด้วย |
| GET / PUT | `w/:ws/projects/:key/notification-settings` | `quietMode` (`after_hours` หรือ `always_send`), `criticalBugBypass` |
| GET / PUT | `w/:ws/projects/:key/report-schedule` | `weekday` 1–7, `time` HH:MM, `channels`, `recipients` (userId) |
| POST | `w/:ws/projects/:key/reports/weekly/send` (และ `weekly:send`) | ส่งรายงานทันที |

### ท่อส่ง

`notifications` ใหม่ → `ChannelDispatcher` (`dispatcher.ts`) → `notification_deliveries` → คิว `channels.deliver` (retry ตาม `Jobs`: ครั้งแรก + 3 ครั้ง)

- **รายคน (Email)**: ตาม `user_notification_prefs` (`event_type` + `channel = email`) · ไม่เคยตั้ง → ใช้ค่าเริ่มต้นตาม Canvas I (`EMAIL_DEFAULT_ON` ใน `dispatcher.ts`) · Workspace ที่ยังส่งอีเมลไม่ได้ (ไม่มี SMTP ของระบบและไม่ได้ยืนยันโดเมนตัวเอง) **ไม่สร้างรายการส่ง** เพื่อไม่ให้ประวัติบอกว่าส่งแล้วทั้งที่ไม่ได้ส่ง
- **กลุ่ม / Webhook**: ตาม `project_notification_rules` ของโปรเจกต์ · เหตุการณ์เดียวที่มีหลายผู้รับส่งครั้งเดียว (จับจาก `created_at` เดียวกัน เพราะ `notify()` เพิ่มทุกแถวด้วยคำสั่งเดียว) · `bug.created` Severity Minor ไม่ส่งเข้ากลุ่ม (L2) · `due_request.*` ตั้งกฎไม่ได้
- **ช่วงงดส่ง** (`quiet.ts`, เวลาไทย): ส่วนตัวใช้ `user_notification_settings` (ไม่มีแถว = 20:00–08:00 + วันหยุด ตาม Profile; แถวที่ `quiet_start/end` เป็น null = ไม่งด) · กลุ่ม / Webhook ใช้ `project_notification_settings` (`after_hours` = หลัง 19:00 ถึงเวลาเริ่มงานของ Workspace และวันหยุด) · Bug Critical ข้ามช่วงงดส่ง (กลุ่มข้ามเมื่อ `criticalBugBypass`) · ส่วนตัว Urgent ข้ามด้วย · รายการที่งด = `skipped_quiet_hours` แล้วงาน `channels.flush-quiet` (ทุก 10 นาที) ส่งเมื่อพ้นช่วง
- **Safe mode**: `workspace_settings.safe_mode` (เปิดเป็นค่าเริ่มต้น) ตรวจตอนส่ง → ส่งเฉพาะหัวข้อ + ลิงก์ ไม่มีรายละเอียดและคอมเมนต์
- **Webhook ล้ม**: retry ครบแล้วล้ม → `failed`, ตั้ง Webhook เป็น `paused` (ไม่ส่งต่อจนกว่าจะเปิดใหม่) และแจ้ง Owner / Admin ด้วยเหตุการณ์ `channel.webhook_paused` · ลายเซ็น: header `x-friday-timestamp` + `x-friday-signature: sha256=HMAC(secret, "<timestamp>.<body>")` · รูปแบบ JSON / Discord / Slack / Teams / Telegram (Telegram ใส่ `?chat_id=` ใน URL)
- **`ChannelSender` / `ChannelRegistry`** (`senders.ts`): LINE (A24) ลงทะเบียน sender ของตัวเองด้วย `registry.register({ channel: 'line' | 'line_group', scope, available, targetFor?, send })` — `scope: 'personal'` ตาม pref ของผู้รับ · `scope: 'project'` ตามกฎของโปรเจกต์ (กฎที่ตั้ง `lineGroupId` ไว้จะทำงานเองเมื่อมี sender `line_group`) · `send` โยน `UnrecoverableError` เมื่อ retry ไม่ช่วย
- **Mailer** (`core/mail.ts`): nodemailer · env `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM` · ไม่ตั้ง `SMTP_HOST` = ปิดเหมือนเดิม (log อย่างเดียว) · **ตั้งแล้วส่งไม่สำเร็จจะ throw** ซึ่งกระทบ `account.service` (ยืนยันอีเมล / ลืมรหัสผ่าน) ที่ `await mailer.send` อยู่ · test แทน `mailer.transportFactory` ได้
- **รายงานรายสัปดาห์**: งาน `channels.weekly-reports` (ทุก 15 นาที) ส่งเมื่อถึงวัน / เวลาที่ตั้ง วันละครั้ง · ตอนนี้ตัวเลขมาจากตาราง `issues` โดยตรง (เสร็จใน 7 วัน, เลยกำหนด, ที่ยังเปิด) เพราะ A09 ยังไม่ merge — เมื่อ merge แล้วให้เปลี่ยน `sendReport` ใน `project-notify.service.ts` ไปใช้ข้อมูลชุดเดียวกับหน้า Reports

### คำตัดสินที่เลือกเอง

- **ต่อท่อกับ Notifier โดยไม่แก้ `notifications/**`** (lane ของ A23): `ChannelDispatcher.hookNotifier()` ครอบ `Notifier.notify` ตอนเริ่ม module เพื่อส่งงาน dispatch ทันที · แจ้งเตือนที่โค้ดอื่นเขียนตรง (`projects.service`, `invitations.service`) ถูกงาน `channels.scan` (ทุกนาที ย้อนดู 5 นาที) เก็บให้ · ส่วนนี้เป็นทางเลี่ยง ดู "คำขอนอก lane"
- **ช่วงเวลา retry**: Admin Console เขียน "1, 5, 30 นาที" แต่ `Jobs` (A16) ใช้ exponential เริ่ม 2 วินาที ×4 ครั้ง · ใช้ตามคิวกลาง ไม่ทำคิวแยก
- **รายงานรายสัปดาห์เป็นข้อความของระบบ** (ไม่มีผู้ทำ) ผู้กดส่งจึงเป็นผู้รับได้ · `report.weekly` เข้า Inbox ด้วย เพราะ `notification_deliveries` ต้องอ้าง `notifications` (A23 ตั้ง `report.weekly` เป็น NO_INBOX เฉพาะฝั่ง fanout)
- **Webhook กัน SSRF**: ต้องเป็น https (ยอม http นอก production), ไม่ชี้ไป loopback / เครือข่ายภายใน / link-local, ไม่ตาม redirect · ตรวจตอนสร้าง / แก้ และตอนส่ง · dev ที่ปลายทางอยู่ในเครื่องตั้ง `WEBHOOK_ALLOW_PRIVATE=1` (test ตั้งให้เอง) · ยังไม่ปักหมุด IP ระหว่างตรวจกับส่ง (DNS rebinding) ควรเสริมตอน deploy ด้วย egress proxy
- กุญแจเข้ารหัส secret ดึงจาก `AUTH_SECRET` ด้วย HKDF คนละ purpose กับ 2FA · เปลี่ยน `AUTH_SECRET` แล้ว secret ของช่องทางเดิมถอดไม่ได้ (ต้องตั้ง URL / secret ใหม่)

### คำขอนอก lane

- **A23** (`notifications/**`): เพิ่ม hook ใน `Notifier.notify` (เช่น `Notifier.onCreated(ids)`) แล้วลบ `hookNotifier()` กับงาน `channels.scan` ออก · ให้ `projects.service` / `invitations.service` เรียกผ่าน Notifier แทนเขียนตรง · digest ปัจจุบันสร้างแจ้งเตือนเฉพาะคนที่เปิด In-app ของ `digest.daily` จึงไม่มี Email digest สำหรับคนที่ปิด In-app ไว้ตามค่าเริ่มต้นของ Canvas I — ต้องให้ reminders สร้างแจ้งเตือนเมื่อเปิด Email แม้ปิด In-app
- **`.env.example`** (ไม่มีเจ้าของ): เพิ่ม `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM`
- **A24**: ลงทะเบียน LINE ผ่าน `ChannelRegistry` (ดูด้านบน) · ปุ่มอนุมัติ / ปฏิเสธใน LINE ไม่อยู่ในงานนี้
- **A14 / A20 / W17**: pref ใช้ `event_type` = ชื่อ Event และ `channel = email` ในตาราง `user_notification_prefs` เหมือน `in_app` ของ A23

### ผล test

`apps/api/test/channels.e2e.test.ts` 31 ข้อ (SMTP ปลอม = `mailer.transportFactory`, Webhook ปลอม = HTTP server ในเครื่อง, เวลาจำลองด้วย fake timers): ส่งตาม pref / ค่าเริ่มต้น / ไม่มี SMTP, scan, retry จนสำเร็จและล้มครบ, Safe mode เปิด / ปิด, Webhook CRUD + เข้ารหัส + SSRF + ลายเซ็น HMAC + ทุกรูปแบบ, ส่งครั้งเดียวต่อเหตุการณ์, ปิดชั่วคราว + แจ้ง Admin + เปิดกลับ, ช่วงงดส่งส่วนตัว / วันหยุด / Critical / Urgent / กลุ่ม / always_send, Email config + DNS + SMTP ของ Workspace + ทดสอบ, deliveries, preview, report-schedule + ส่งรายสัปดาห์วันละครั้ง · `pnpm typecheck` ผ่าน · API 263 ผ่าน (ข้าม 6 = เดิม)
