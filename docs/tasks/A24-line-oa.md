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

- [ ] test ด้วย LINE API ปลอม: ผูกบัญชี, อนุมัติจาก postback, บัญชีที่ไม่ได้ผูกกดแล้วถูกปฏิเสธ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
