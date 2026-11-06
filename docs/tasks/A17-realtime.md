# A17 · Realtime (WebSocket)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/realtime/**` · `apps/api/test/realtime.e2e.test.ts` · `apps/api/src/bootstrap.ts` |
| หน้าจอ | K4 (`design/canvas/Bell.dc.html`) · C (`design/canvas/TaskDetail.dc.html`) · M1 (`design/canvas/States.dc.html`) · L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 1 Realtime |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- WebSocket เดียวต่อแท็บที่ `/realtime` (Nest WsAdapter) · ยืนยันตัวตนด้วย Session cookie ตอน upgrade
- ช่อง `user:{id}`, `project:{id}` (ตรวจสิทธิ์ตอน subscribe), `issue:{id}` (ใครกำลังดู / พิมพ์), `import:{jobId}`
- ฟัง `EventBus.on("*")` แล้วส่งสัญญาณ `{ type, issueKey, id, version }` · ข้อมูลจริงหน้าเว็บดึงผ่าน REST
- แจ้งเตือนใหม่ → `user:{id}` พร้อมจำนวนยังไม่อ่าน (ฟังจาก Notifier: เพิ่ม hook ฝั่ง realtime โดยไม่แก้ `notifier.ts` เช่น poll ตาราง หรือขอ A23 ส่ง Event)

## กติกาที่ต้องตรง

- ข้อความใน WebSocket เป็นแค่สัญญาณ ไม่มีข้อมูลที่ต้องตรวจสิทธิ์

## เสร็จเมื่อ

- [x] test ด้วย client `ws`: subscribe โปรเจกต์ที่ไม่มีสิทธิ์ถูกปฏิเสธ · แก้งานแล้วได้สัญญาณ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### สิ่งที่เพิ่ม (`apps/api/src/realtime/`)

- WebSocket ที่ `/realtime` (และ `/api/v1/realtime`) ใช้ `ws` ผูกกับ event `upgrade` ของ HTTP server โดยตรง (ไม่ใช้ Nest WsAdapter เพื่อไม่ต้องแก้ `main.ts`/`bootstrap.ts`) · ยืนยันตัวตนด้วยคุกกี้ `fm_session` ตอน upgrade: ไม่มี/ผิด → 401 · Origin แปลก → 403 (กัน Cross-Site WebSocket Hijacking; เพิ่มได้ด้วย `REALTIME_ALLOWED_ORIGINS`)
- ข้อความ client → server (JSON, ≤4KB): `ping`, `subscribe`, `unsubscribe`, `presence {state: viewing|typing}` · ตอบ `ready`, `pong`, `subscribed`, `unsubscribed`, `error {code}` (`forbidden`, `invalid_channel`, `invalid_message`, `unknown_op`, `too_many_subscriptions`, `not_subscribed`)
- ช่อง: `user:{id}` (ของตัวเองเท่านั้น), `project:{id}` (`projectAccess`; Guest ไม่ได้), `issue:{id}` (Guest Viewer ได้เฉพาะงานที่แชร์และไม่ใช่ Bug), `import:{jobId}` (ผู้สร้างงานนำเข้า) · ตรวจสิทธิ์ทุก subscribe, สูงสุด 50 ช่องต่อการเชื่อมต่อ
- สัญญาณ: ฟัง `EventBus.on('*')` ส่ง `{ channel, type, issueKey, id, version, actorId, at }` เท่านั้น ไม่มีชื่องาน/ชื่อคน
- Presence: subscribe ช่องงานได้ `presence_list`, สถานะส่งถึงคนอื่นไม่ถึงตัวเอง, ออกแล้วแจ้ง `left`, จำกัด 10 ครั้ง/วินาที
- แจ้งเตือน: poll ตาราง `notifications` (ผ่าน `SYSTEM_DB` ค่าเริ่มต้น 2 วินาที ปรับด้วย `REALTIME_POLL_MS`) แล้วส่ง `notification` พร้อม `unread {total, byWorkspace}` ไปช่อง `user:{id}` ที่มีคน subscribe · ครอบคลุมแจ้งเตือนที่โค้ดอื่นเขียนตรงลงตารางด้วย
- ความทนทาน: heartbeat 30 วินาที, ตรวจ Session + สิทธิ์ซ้ำทุก 5 นาที (`recheck`) — ถอนสิทธิ์ → `unsubscribed`, Session หมด/ถูก revoke → ปิดด้วย code 4401 · `RealtimeService.publish(channel, payload)` ให้ A15 ส่งความคืบหน้านำเข้า (`import:{jobId}`)

### คำตัดสินที่เลือกเอง

- ใช้ poll แทนขอ hook ใน Notifier (ตามที่ไฟล์งานอนุญาต); ถ้า A23 เพิ่ม `Notifier.onCreated` ภายหลังให้เปลี่ยนมาฟังแทน
- ไม่แก้ `bootstrap.ts`: ผูก `upgrade` ใน `onApplicationBootstrap`
- รันหลาย instance ต้องใช้ pub/sub (Valkey) ต่อภายหลัง ตอนนี้สัญญาณส่งเฉพาะ instance ที่ event เกิด

### คำขอนอก lane

- **A15**: ส่งความคืบหน้าด้วย `RealtimeService.publish('import:{jobId}', { type: 'import.progress', done, total })`
- **W-ทั้งหลาย**: ต่อ `wss://…/api/v1/realtime`; ได้สัญญาณแล้วดึงข้อมูลผ่าน REST

### ผล test

`apps/api/test/realtime.e2e.test.ts` 15 ข้อ ใช้ client `ws` จริง: 401/403, Origin, ping/ข้อความผิดรูป, สิทธิ์ทุกช่อง (โปรเจกต์ private, Guest, import), จำกัด 50 ช่อง, สัญญาณ issue.created/updated/commented, presence + rate limit, unread push, recheck ถอนสิทธิ์/ปิด Session · `pnpm typecheck` ผ่าน · API 452 ผ่าน (ข้าม 6 = เดิม)
