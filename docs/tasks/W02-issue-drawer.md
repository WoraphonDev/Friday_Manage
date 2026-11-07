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

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- ใช้ `IssueDrawer({issueKey,onClose})` เดิมของ ProjectShell: เปิดจาก `?issue=KEY` / `?new=1`, รักษา query filter อื่น, Sub-task ซ้อนชั้น 2 พร้อมปุ่มและแป้นลูกศรสลับ siblings จาก `parent.subtasks` · ถ้า Guest อ่านงานแม่ไม่ได้ ให้แสดงเฉพาะงานลูกที่ API อนุญาต
- เพิ่มแก้ฟิลด์/assignees/move ด้วย If-Match, แถบ 409 เก็บ draft และโหลดล่าสุด, ยืนยันปิดงานที่มี Sub-task ค้าง, ขอเหตุผลแก้แผน Baseline, ขอเลื่อน Due พร้อม preview/ผู้อนุมัติ/คำเตือน และยกเลิกคำขอของตนเอง · ลบหลังโหลด delete-impact พร้อม Undo/restore และสถานะ 410
- เพิ่ม Checklist/Acceptance criteria (แก้ข้อความ/เรียงลำดับ/ติ๊ก/ลบ), Dependency FS/SS/FF/SF พร้อม lag/warnings, Watch, Activity แบบ cursor และคอมเมนต์ Markdown/@mention/แก้ไข/ลบ · ใช้ `react-markdown` + `remark-gfm` โดยไม่เปิด raw HTML
- ฟอร์ม Task/Sub-task/Bug/Story/Spike อ่านชนิด/requiredFields/status/สมาชิก/MD จาก form-options, รับฟิลด์บังคับที่เพิ่มข้ามประเภท, คำนวณ Spike MD จาก Timebox, สร้าง Sub-task/Checklist/Dependency ต่อจากงานหลัก, สร้างต่ออีกรายการ, Ctrl/⌘+Enter และเก็บ draft 7 วันแยก Workspace/Project/ผู้ใช้ · ถ้ารายการเสริมล้มเหลว ล็อกฟอร์มและทำต่อเฉพาะขั้นที่ยังไม่ได้รับผลสำเร็จ
- สิ่งที่ต่างจาก Canvas: ใช้ความกว้าง Drawer 760 px/rail ของ UI kit เดิมแทน 860 px ใน Canvas; บนมือถือย้ายฟิลด์รองเข้า “คุณสมบัติเพิ่มเติม”; ซ่อน Files/ผลทดสอบ/Git/แนบไฟล์/Labels ซึ่ง API ที่ merge แล้วยังไม่รองรับ · เพิ่มปุ่มแก้ไขและยืนยันแทนฟิลด์ที่ดูเหมือนแก้ได้แต่ไม่มี endpoint
- ข้อจำกัด/คำขอนอก lane: 409 ส่ง `latest` แต่ไม่มีผู้แก้ไข จึงใช้ข้อความ “ผู้ใช้อื่น” พร้อมข้อมูลล่าสุด/requestId; ขอ A03 เพิ่ม actor หากต้องแสดงชื่อ · การสร้างงานพร้อมรายการเสริมไม่มี transaction/idempotency key: ป้องกันส่งซ้ำเฉพาะขั้นที่ได้รับ ACK แล้ว แต่กรณีเซิร์ฟเวอร์สำเร็จและเครือข่ายตัดก่อนรับผลยังต้องตรวจงานที่สร้างก่อนลองใหม่ · API Checklist/Dependency ปัจจุบันกำหนด issue.edit แม้ GET จึงซ่อนแท็บสำหรับผู้อ่านอย่างเดียว
- ตรวจจริงด้วย API และข้อมูลสมมติใน DB `friday_w02` แยกจากงานอื่น: Detail/New form ที่ 1440×1000 และ 390×844, Sub-task ที่ 390×844 และสลับ DE-2 → DE-3 สำเร็จ · ภาพอยู่ใน `apps/web/src/features/issue-drawer/__qa__/` (PNG DPR 2) · ตรวจเทียบโครงหน้าจอ Canvas C/D/B/K1/M4 และใช้ UI kit เดิม
- MSW ของ W02 33 เคส รวม If-Match/409/422/Baseline, Due preview/submit/cancel, Checklist/Dependency/Activity, สร้างทุกประเภท/requiredFields/partial retry/draft, Guest/403/404/410, delete/Undo และแยก cache เมื่อเปลี่ยน Workspace · เว็บรวม 86 เคสผ่าน; typecheck ทั้ง repo และ production build ผ่าน; DB 105/API 177 เคสผ่าน (6 queue integration ข้ามเมื่อไม่มี Valkey ตามค่าเริ่มต้นของชุดทดสอบ) · Shell fixture เดิมไม่ได้ mock GET issue จึงมี MSW warning หนึ่งรายการ แต่ test ผ่าน

### จัดแผงรายละเอียดงานใหม่ — 2026-11-07

- **ต่างจาก Canvas C โดยตั้งใจ** (ผู้ใช้แจ้งว่าใช้ยากและข้อมูลแสดงไม่หมด): Drawer 1000px (Canvas 860) และลากขอบซ้ายขยาย / หดได้ จำความกว้างใน browser · แผงคุณสมบัติ 340px (Canvas 240)
- แผงแบ่งกลุ่ม คน / แผนงาน / จัดกลุ่ม · ไม่มีแถวสถานะซ้ำกับปุ่มบนหัว · Size + Man-Day บรรทัดเดียว · ขอเลื่อน Due อยู่ใต้แถว Due ในกล่องแผน · Actual Start แก้ได้ · Progress แถบกับ % แถวเดียว · ตัดข้อความ "คลิกค่าใดก็ได้"
- ส่วนที่ว่าง (คำอธิบาย, Dependency) ย่อเหลือบรรทัดเดียวพร้อมปุ่มเพิ่ม
- คำขอนอก lane: W00 `overlays.tsx` (ขอบลาก Drawer) และ `globals.css`
