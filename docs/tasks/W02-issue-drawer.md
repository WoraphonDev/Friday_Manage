# W02 · Drawer งาน (Task / Sub-task / Bug), ฟอร์มสร้างงาน, ขอเลื่อน Due, Dialog ยืนยัน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A01, A02, A03 |
| Lane (แก้ได้เฉพาะ) | `apps/web/src/features/issue-drawer/**` · `apps/web/messages/th/issue-drawer.json` |
| หน้าจอ | C (`design/canvas/TaskDetail.dc.html`) · D (`design/canvas/SubtaskModal.dc.html`) · K2 (`design/canvas/BugDetail.dc.html`) · B (`design/canvas/TaskCreate.dc.html`) · K1 (`design/canvas/IssueCreate.dc.html`) · K3 (`design/canvas/DueRequest.dc.html`) · P3 (`design/canvas/ConfirmDialogs.dc.html`) · M4 (`design/canvas/MobileSubtask.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.7 ทั้งหมด · 03-api › กติกาการเปลี่ยน Due |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Drawer ขวา, Sub-task ซ้อนชั้น 2, สลับ Sub-task ด้วย siblings
- แก้ทีละฟิลด์ด้วย If-Match · 409 แสดงแถบ "ถูกแก้โดย … ขณะที่คุณกำลังแก้" ตาม M1
- เลื่อน Due ไม่มีสิทธิ์ → เปิดฟอร์ม K3 พร้อม preview ผลกระทบ · แถบคำขอที่รออยู่ + ยกเลิก
- แท็บ Checklist, Dependency, ไฟล์, ผลทดสอบ, Activity + คอมเมนต์, Git (แสดงเฉพาะส่วนที่ API มีแล้ว ที่เหลือซ่อน)
- ฟอร์ม B / K1 ตามประเภทงานและฟิลด์บังคับจาก `p/form-options`
- ลบ / เลิกทำ (P3)

## กติกาที่ต้องตรง

- เป็น component ที่ทุกหน้าในโปรเจกต์ใช้: เปิดด้วย URL `?issue=KEY`

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
