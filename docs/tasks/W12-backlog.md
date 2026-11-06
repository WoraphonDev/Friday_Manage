# W12 · Backlog + Sprint planning

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A06 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/backlog/**` · `apps/web/messages/th/backlog.json` |
| หน้าจอ | L1 (`design/canvas/Backlog.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET p/backlog` (A06) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ลากงานระหว่าง Backlog / Sprint (`POST i/move` sprintId + ลำดับ), capacity bar, Start / Complete Sprint, Burndown

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

- หน้า `w/[ws]/p/[key]/backlog` แทน placeholder: `page.tsx` เรียก `BacklogView` ("use client") ใน `_components/` · CSS module · ข้อความ namespace `backlog` (`messages/th/backlog.json`)
- API ที่ใช้: `GET p/backlog` (A06), `GET p/my-permissions`, `GET p/modules` และ `GET p/members` (ชื่อ Module / คน เพราะ issueDto ของ A06 ส่งแค่ `moduleId` / `assigneeIds` · โหลดแยกและไม่บล็อกหน้าถ้าล้มเหลว · คนที่ไม่อยู่ใน members ใช้ `capacity.people` แทน), `POST i/move` (`sprintId` + `afterKey`/`beforeKey`, ส่ง If-Match ตาม version), `POST p/sprints`, `PATCH p/sprints/{id}` (goal), `POST p/sprints/{id}/start`, `POST p/sprints/{id}/complete`
- Sprint active: ACTIVE, ช่วงวันที่, "เหลือ N วันทำการ" (อนุมานจากเส้นอุดมคติที่ลดเฉพาะวันทำการ จึงไม่แสดงเมื่อ baseline = 0), เปิดบอร์ด, Sprint goal, สถิติงาน/MD/Bug เปิดอยู่ และ Burndown (SVG เขียนเอง: เส้นแผนประ + จุดจริงจาก snapshot ไม่เติมวันที่ไม่มีข้อมูล) · Canvas ไม่มีรายการงานของ Sprint active จึงซ่อนไว้หลังปุ่ม "แสดงงานใน Sprint" (ยังลากเข้า/ออกได้เมื่อเปิด)
- Sprint planning: แก้ goal ได้ (PATCH ตอนออกจากช่อง), แถบ Commit vs capacity (น้ำเงิน / เขียว ≥ 80% / แดงเมื่อ overloaded) เป็น `role="meter"`, หมายเหตุ capacity, MD ที่ไม่มีผู้รับผิดชอบ, งานที่ยังไม่ประเมิน และ chip รายคน (committed / capacity, วันลา, สีแดงเมื่อเกิน)
- ย้าย/เรียง: ลากแถว (วางบนแถว = วางก่อนแถวนั้น, วางในพื้นที่ว่าง = ต่อท้าย), ปุ่มหลัก "↑ Sprint ถัดไป" / "↓ Backlog" ตาม Canvas และปุ่ม ⋯ เปิด Dialog (เลื่อนขึ้น / ลง, ย้ายไป Backlog หรือ Sprint ใดก็ได้) เป็นทางเลือกด้วยคีย์บอร์ด · เพื่อนบ้านคำนวณจากรายการเต็มของปลายทาง (ไม่ใช่รายการที่กรอง) เพื่อให้ rank ถูกแม้มีตัวกรอง · ล็อกให้ย้ายทีละครั้ง, แจ้งผล + warnings + เลิกทำ (ย้ายกลับตำแหน่งเดิมด้วย version ใหม่), 409 แสดงข้อความชนกันพร้อมรหัสคำขอและโหลดค่าล่าสุด · ย้ายได้เฉพาะงานระดับบน (Sub-task ตามแม่ตาม API) แสดงจำนวน Sub-task ต่อท้ายชื่อ
- Start Sprint: Dialog ยืนยันพร้อมจำนวนงาน / commit vs capacity และคำเตือนเมื่อเกินหรือมีงานยังไม่ประเมิน · ปุ่มถูกปิดเมื่อมี Sprint active อยู่ (API ตอบ 409 อยู่แล้ว) · Complete Sprint: สรุปเสร็จ / ไม่เสร็จ (งาน · MD ระดับล่างสุดตาม stats), รายชื่องานแม่ที่ยังไม่ Done 10 งานแรก + "อีก n งาน", เลือกปลายทางเป็น Sprint planning (อันแรก "แนะนำ") หรือ Backlog, Retrospective ไม่บังคับ แล้วแจ้งจำนวนที่ย้ายจาก `moved` · error ของ Dialog แสดงข้อความ API + รหัสคำขอ
- สร้าง Sprint: ชื่อเริ่มต้น `Sprint {n+1}`, เริ่มวันถัดจาก Sprint ล่าสุด (หรือวันนี้) ยาว 14 วัน, ตรวจวันจบไม่ก่อนวันเริ่ม · ตัวกรองประเภท (ทั้งหมด / Task / Bug ตาม Canvas) และ Module
- สิทธิ์: Guest Viewer / 403 → Forbidden โดยไม่เรียก backlog · ปุ่มย้าย/ลากต้องมี `issue.edit`, สร้าง/เริ่ม/ปิด Sprint และแก้ goal ต้องมี `sprint.manage`, สร้างงานต้องมี `issue.create` (จาก `my-permissions`)
- ต่างจาก Canvas / ตัดสินเอง: ช่อง "+ เพิ่มงานใน Backlog แล้วกด Enter (bug:)" เปลี่ยนเป็นลิงก์ `?new=1` ไปฟอร์มสร้างงานของ W02 เพราะ quick-add ต้องเลือกประเภท/Workflow ที่ backlog API ไม่ได้ส่งมา · กล่อง "ปิดได้เฉลี่ยต่อ Sprint" ไม่แสดงเพราะ API ไม่มี velocity ของ Sprint ที่จบแล้ว · ยังไม่มี UI แก้ชื่อ/วันที่ของ Sprint ที่สร้างแล้ว (PATCH รองรับ) · หมายเหตุ capacity แสดงสมาชิก × วันทำการแทนสูตรรายคนแบบ Canvas
- คำขอนอก lane: (ไม่บังคับ) ให้ A06 ส่งชื่อ Module และ assignees แบบ Person ใน issueDto ของ `GET p/backlog` และ velocity ย้อนหลัง เพื่อลดการเรียก `modules` / `members` และแสดงกล่องค่าเฉลี่ยตาม Canvas · ข้อสังเกตของ A06 เรื่อง `i/move` ยังย้ายงานเข้า Sprint ที่ completed ได้ไม่กระทบหน้านี้ เพราะหน้าแสดงเฉพาะ Sprint ที่ยังไม่จบเป็นปลายทาง
- Test: `src/lib/backlog.test.tsx` 13 ข้อ (MSW, ข้อมูลสมมติ): แสดง Sprint/Burndown/capacity/Backlog, ปุ่มย้าย + CSRF + If-Match + เลิกทำ, ลากข้าม Sprint/Backlog และเรียงลำดับ, Dialog คีย์บอร์ด, 409 + requestId, Complete (ปลายทาง + Retrospective), Start (เตือนเกิน capacity / ปิดเมื่อมี active), แก้ goal, สร้าง Sprint, ตัวกรอง, Viewer ซ่อนปุ่ม, โหลด/ว่าง/Error/403 และ Guest Viewer · `pnpm --filter @friday/web typecheck`, `test` (160 ผ่าน) และ `build` ผ่าน
- ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440/390 px
