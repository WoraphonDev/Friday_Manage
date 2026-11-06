# A24 · LINE OA: ผูกบัญชี, กลุ่ม และปุ่มอนุมัติคำขอเลื่อน Due

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | A25 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/line/**` · `apps/api/test/line.e2e.test.ts` · route `me/line*`, `w/channels/line-*`, `hooks/line` |
| หน้าจอ | I (`design/canvas/Profile.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) · N2 (`design/canvas/NotifyTemplates.dc.html`) · K3 (`design/canvas/DueRequest.dc.html`) · G (`design/canvas/Inbox.dc.html`) |
| สเปก | 03-api › 3.1 แถว `me/line*` · 03-api › 3.11 `/hooks/line` · คำตัดสิน: อนุมัติผ่านปุ่ม LINE ได้ (ตรวจบัญชีที่ผูก + Audit) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET / PUT w/channels/line-oa` + `:test` · `GET w/channels/line-groups`
- `POST me/line/link-code` (6 หลัก 10 นาที) · `DELETE me/line` · `POST me/line:test`
- `POST hooks/line` (ตรวจลายเซ็น): ผูกบัญชีจากรหัส, OA เข้า / ออกกลุ่ม, postback อนุมัติ / ปฏิเสธ → `DueRequestsService.decide(..., via "line")` หลังตรวจว่าบัญชี LINE ผูกกับผู้มีสิทธิ์อนุมัติ · Audit ทุกครั้ง
- `ChannelSender` สำหรับ LINE (ข้อความส่วนตัว + กลุ่ม) ต่อเข้าท่อของ A25

## กติกาที่ต้องตรง

- ต่อเข้าท่อของ A25 ผ่าน `ChannelSender` ที่ A25 export · ไม่แก้ไฟล์ใน `channels/`

## เสร็จเมื่อ

- [x] test ด้วย LINE API ปลอม: ผูกบัญชี, อนุมัติจาก postback, บัญชีที่ไม่ได้ผูกกดแล้วถูกปฏิเสธ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/line/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET / PUT | `w/:ws/channels/line-oa` | Owner / Admin | เก็บ Channel secret + access token แบบเข้ารหัส ตอบกลับ `...Last4` · ตั้งครั้งแรกต้องส่งทั้งสองค่า · ตอบ `webhookUrl` ให้นำไปใส่ใน LINE Developers Console |
| POST | `w/:ws/channels/line-oa/test` (และ `line-oa:test`) | Owner / Admin | ถาม `GET /v2/bot/info` ด้วย token · ล้ม 502 `line_test_failed` |
| GET | `w/:ws/channels/line-groups` | Owner / Admin | กลุ่มที่ OA เข้าอยู่ (จาก webhook) · `id` ใช้อ้างใน `p/notification-rules` (`lineGroupId`) |
| GET | `me/line` | self | `{ linked, displayName, boundAt }` |
| POST | `me/line/link-code` | self | รหัส 6 หลัก หมดอายุ 10 นาที · ขอใหม่แล้วรหัสเก่าใช้ไม่ได้ · เก็บเฉพาะ HMAC |
| DELETE | `me/line` | self | ยกเลิกการผูก (ลบแถว `line_bindings`) |
| POST | `me/line/test` (และ `me/line:test`) `{ workspace }` | self | ส่งข้อความทดสอบหาตัวเองผ่าน OA ของ Workspace นั้น |
| POST | `hooks/line/:workspaceId` | ตรวจลายเซ็น LINE (`x-line-signature`) | ดู "คำตัดสิน" ว่าทำไมมี `:workspaceId` |

### Webhook (`hooks/line/:workspaceId`)

- ตรวจลายเซ็น base64 HMAC-SHA256 ของ raw body ด้วย Channel secret ของ Workspace (เปรียบเทียบแบบ timing-safe) · ผิด/ไม่มี → 401 · ถูกแล้วตอบ 200 เสมอ (error ของ event แต่ละตัวถูก log ไม่ทำให้ LINE ส่งซ้ำ)
- **message** (แชตส่วนตัว) ข้อความเป็นเลข 6 หลัก = ผูกบัญชี: ตรวจรหัสยังไม่ใช้/ไม่หมดอายุ + เจ้าของรหัสเป็นสมาชิก active ของ Workspace นี้ + ผู้ใช้/บัญชี LINE นี้ยังไม่ถูกผูก → สร้าง `line_bindings`, Audit `line.linked`, ตอบกลับ · ส่งรหัสผิดเกิน 10 ครั้ง/10 นาที ต่อบัญชี LINE → เมินเงียบ (กันเดา)
- **join / leave** กลุ่ม: เพิ่ม/อัปเดตชื่อ (จาก group summary) / ลบ `line_groups` (กฎแจ้งเตือนที่อ้างกลุ่มถูกลบตาม cascade)
- **follow**: ตอบวิธีผูกบัญชี
- **postback** อนุมัติ/ปฏิเสธ (`a=due&id=<requestId>&d=approve|reject`): บัญชี LINE → `line_bindings` → ผู้ใช้ → ต้องเป็นสมาชิก active ของ Workspace → `DueRequestsService.decide(..., 'line')` (ตรวจ `due_request.approve`, ห้ามอนุมัติของตัวเอง, 409 `already_decided`) → **Audit ทุกครั้ง** `due_request.line_postback` (สำเร็จ / ไม่สำเร็จ+รหัส / บัญชี LINE ไม่ได้ผูก = actor ว่าง) → ตอบผลกลับใน LINE

### ส่งแจ้งเตือน (ต่อท่อของ A25 ผ่าน `ChannelRegistry`)

- `LinePersonalSender` (`line`, personal): ตาม pref ของผู้รับ (`user_notification_prefs.channel = line`) และต้องผูกบัญชีแล้ว · คำขอเลื่อน Due (`due_request.created`) ส่งเป็น **Flex พร้อมปุ่ม อนุมัติ / ปฏิเสธ / เปิดในแอป**
- `LineGroupSender` (`line_group`, project): ตามกฎ `p/notification-rules` (`lineGroupId`) · ข้อความธรรมดา (คำขอเลื่อน Due ส่งเข้ากลุ่มไม่ได้อยู่แล้ว)
- ตอบ 4xx (ถูกบล็อก / token ผิด / กลุ่มไม่มีแล้ว) = ไม่ลองใหม่ · 429 และ 5xx ลองใหม่ตามคิวของ A16 · ใช้ช่วงงดส่ง / Safe mode / ประวัติการส่งของ A25 ตามเดิม

### คำตัดสินที่เลือกเอง

- **Webhook URL ต่อ Workspace** (`/api/v1/hooks/line/{workspaceId}`) ไม่ใช่ `/hooks/line` เดี่ยว: แต่ละ Workspace มี OA และ Channel secret ของตัวเอง ต้องรู้ว่าจะตรวจลายเซ็นด้วย secret ไหน (payload ของ LINE ไม่บอก Workspace) และรหัสผูกบัญชีต้องตรวจกับสมาชิกของ Workspace ที่รับแชต
- ยกเลิกการผูกลบแถวทิ้ง (ไม่ใช้ `unbound_at`) เพราะ `user_id` และ `line_user_id` เป็น unique ถ้าเก็บแถวไว้จะผูกใหม่ไม่ได้
- หาคำขอที่ต้องแนบปุ่มจาก Issue key ใน title ของข้อความ (SendContext ของ A25 ไม่มี payload) แล้วหา `due_change_requests` ที่ยัง `pending` ของงานนั้น
- ไม่ส่งแจ้งเตือนรวม (`batch_digest_minutes`) และ `fallback_to_email`: เก็บค่าไว้แล้วแต่ยังไม่มีผล เพราะต้องแก้ท่อใน `channels/dispatcher.ts` (ดูคำขอนอก lane)

### การแก้นอก lane ที่ประสานแล้ว (จำเป็นต่อให้ webhook ทำงานได้)

1. `auth/auth.guard.ts`: **ข้ามการตรวจ CSRF เมื่อ path ขึ้นต้น `/api/v1/hooks/`** · เดิม `AuthGuard` บังคับ CSRF กับทุก POST รวม `@Public()` ทำให้ LINE / GitHub / Stripe เรียกไม่ได้ (403 `csrf_failed`) · A27 (GitHub) และ A33 (Stripe) ใช้ประโยชน์ได้เลย แต่ต้องตรวจลายเซ็นเองทุก route
2. `bootstrap.ts`: เปิด `rawBody: true` เพื่อตรวจลายเซ็นจาก byte จริงของ body (ถ้าแปลง JSON กลับอาจไม่เหมือนเดิม)

### คำขอนอก lane

- **A25** (`channels/dispatcher.ts`): ค่าเริ่มต้นของ pref รู้จักแต่ Email (`EMAIL_DEFAULT_ON`) ทำให้ LINE ปิดไว้จนกว่าผู้ใช้จะเปิดเอง ทั้งที่ Canvas I ให้ LINE เปิดตั้งแต่ต้นในหลายแถว (มอบหมาย, Review, @mention, คำขอเลื่อน Due, เลยกำหนด ฯลฯ) · แนะนำเพิ่ม `defaultOn?(eventType)` ใน `ChannelSender` · เช่นเดียวกับ `fallback_to_email` (LINE ผูกไม่ได้/ส่งไม่ได้ → ส่ง Email แทน) และ `batch_digest_minutes`
- **A25**: `SendContext` ควรพก `notification {id, eventType, payload}` จะได้ไม่ต้องเดา `requestId` จาก title
- **A17 / I01**: ถ้าจะให้ URL เป็น `/hooks/line/...` ตามสเปกต้องตั้ง `setGlobalPrefix('api/v1', { exclude: ['hooks/(.*)'] })` ใน `bootstrap.ts` และ proxy ภายนอกให้ตรงกัน
- **A17 (Realtime)**: สเปกให้แจ้งผ่าน WebSocket เมื่อผูกเสร็จ ยังไม่มีช่องทางนี้ ตอนนี้หน้า Profile ต้อง poll `GET me/line`

### ผล test

`apps/api/test/line.e2e.test.ts` 18 ข้อ (LINE API ปลอม): ตั้งค่า (เข้ารหัส/4 ตัวท้าย/แก้โดยไม่ส่ง secret/Audit) · :test (ถูก/ผิด token/Member 403) · ลายเซ็น (ผิด/ไม่มี/secret อื่น/Workspace ไม่มี → 401/404, ไม่ต้อง CSRF) · ผูกบัญชี (รหัส/ใช้ครั้งเดียว/ผิด/หมดอายุ/รหัสเก่า/ผูกแล้ว/LINE ถูกใช้/ไม่ใช่สมาชิก/ยกเลิกแล้วผูกใหม่/กันเดา) · `me/line:test` · กลุ่ม join/leave + cascade กฎ · **อนุมัติ/ปฏิเสธจาก postback** (สำเร็จ via line + แก้ Due + Audit, ซ้ำ, บัญชีที่ไม่ได้ผูกถูกปฏิเสธ, ไม่มีสิทธิ์, ไม่ใช่สมาชิก, ข้อมูลผิด) · ส่งผ่านท่อ A25 (ตาม pref, ปุ่ม Flex ที่กดแล้วอนุมัติจริง, กลุ่มครั้งเดียวต่อเหตุการณ์, 4xx ไม่ลองใหม่) · `pnpm typecheck` ผ่าน · API ทั้งชุด 347 ผ่าน
