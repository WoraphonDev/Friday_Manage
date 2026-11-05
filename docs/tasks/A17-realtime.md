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

- [ ] test ด้วย client `ws`: subscribe โปรเจกต์ที่ไม่มีสิทธิ์ถูกปฏิเสธ · แก้งานแล้วได้สัญญาณ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
