# W15 · Lead Dashboard และ Reports

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A09 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/dashboard/**` · `apps/web/app/w/[ws]/p/[key]/reports/**` · `apps/web/messages/th/lead-dashboard-reports.json` |
| หน้าจอ | O1 (`design/canvas/LeadDashboard.dc.html`) · O2 (`design/canvas/Reports.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.9 แถว insights, reports |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ตามหน้าจอ · กราฟตามแนวทาง dataviz ของ design system

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### หน้าที่เพิ่ม

| เส้นทาง | Component | API ที่ใช้ |
|---|---|---|
| `p/[key]/dashboard` (O1) | `dashboard/_components/lead-dashboard.tsx` · `workload-heatmap.tsx` | `insights/risks` · `insights/modules` · `workload?from&to&group=week&unit=md` · `reports/weekly?week=` (2 ครั้ง สำหรับ KPI สัปดาห์นี้ / หน้า) |
| `p/[key]/reports` (O2) | `reports/_components/reports-view.tsx` · `weekly-report.tsx` · `plan-vs-actual.tsx` · `traceability.tsx` | `reports/weekly?week=` · `report-schedule` · `POST reports/weekly:send` · `reports/module-forecast?weeks=8` · `reports/traceability?kind&result` |

- ชนิดข้อมูลของคำตอบ API อยู่ที่ `dashboard/_components/types.ts` (หน้า Reports import จากที่นี่) · ข้อความทั้งหมดอยู่ใน `messages/th/lead-dashboard-reports.json`
- กราฟเป็น SVG / CSS เขียนเอง ไม่เพิ่ม dependency: Heatmap Workload (CSS grid), แถบช่วงเวลาของ Module, กราฟแท่งคู่ Plan vs Actual รายสัปดาห์ (SVG มี `role="img"` + `aria-label` สรุปตัวเลข และ `<title>` ทุกแท่ง)
- สถานะ M1: `LoadingState` · `EmptyState` (ยังไม่มีงานในแผน / ยังไม่มี Module) · `ErrorState` พร้อม requestId (ทั้งหน้า และเฉพาะการ์ด Workload ที่โหลดไม่ได้โดยไม่บล็อกส่วนอื่น) · `Forbidden` เมื่อ 403, Guest Viewer หรือไม่มี `project.workload.view` (O1) / `project.reports.view` (O2) · ปุ่ม "ส่งตอนนี้" แสดงเฉพาะผู้มี `project.settings` (สิทธิ์ที่ `weekly:send` ใช้) และเฉพาะสัปดาห์ปัจจุบัน
- ลิงก์งานทั้งหมดใช้ `?issue=KEY` บนหน้าเดิม (เปิด Drawer ของ W02)
- Test: `src/lib/lead-dashboard-reports.test.tsx` 12 ข้อ (ตรึงวันที่ พ. 2 ธ.ค. 2569 ด้วย fake Date) · `pnpm --filter @friday/web typecheck test build` ผ่าน

### จุดที่ต่างจาก Canvas และเหตุผล

- **หัวหน้าโปรเจกต์ / แท็บ** อยู่ใน `ProjectShell` (ไฟล์กลางของ W00) · ปุ่ม "สร้างรายงานประจำสัปดาห์", "Import / Export" และ pill สถานะ (Off track) ย้ายมาอยู่แถบบนสุดของหน้า Dashboard · pill "นำเข้าจาก Excel · Baseline v1" ไม่ได้ทำ เพราะ API ของหน้านี้ไม่มีข้อมูลนั้น
- ข้อความ "ข้อมูลจริงจาก … · สถานะจำลอง" ของ Canvas เป็นคำอธิบาย mockup · เปลี่ยนเป็น "ข้อมูล ณ {วันที่}"
- **KPI**: งานทั้งหมด แสดง "N Module · เสร็จ X%" แทน "BA 8 · Dev 6" (API ไม่แยกคนตามตำแหน่ง) · Man-Day ตามแผน แสดง "เสร็จ · เหลือ" แทนจำนวนแยกตาม Size · ช่วงแผน = วันเริ่มแรกสุดถึงวันจบหลังสุดของ Module · ต้องใช้จริงตาม capacity ใช้ `requiredWeeks` (MD ที่**เหลือ** ÷ capacity) และขึ้นกรอบแดงเมื่อ `gapWeeks > 0` · เริ่มสัปดาห์นี้ / หน้า ได้จาก `nextWeek.starting` ของรายงานสัปดาห์ก่อน / สัปดาห์นี้
- **ความเสี่ยง**: หัวข้อและรายละเอียดมาจาก API (`title`, `detail`) · ปุ่มต่อท้ายเลือกตามชนิด (`overdue` → Table, `due_soon_low_progress` → Calendar, `capacity_over` → Members, `blocked` → Gantt, `pending_due_requests` → Inbox) · เพิ่มลิงก์รหัสงาน (สูงสุด 6) ใต้รายละเอียด
- **Heatmap Workload**: 24 สัปดาห์ โดยสัปดาห์นี้เป็นคอลัมน์ที่ 5 เหมือน Canvas · สีเทียบ capacity จริงของคนนั้นในสัปดาห์นั้น (หักวันลา / วันหยุด) แทน 5 MD คงที่ · "ไม่รวมงานของ BA" ไม่ได้ทำ เพราะ `workload` กรองได้ด้วย `position` เท่านั้นและไม่รู้ชื่อตำแหน่งของ Dev ล่วงหน้า · คลิกช่องเปิดแผงรายการงานของสัปดาห์นั้น (ลิงก์ไป Drawer เพื่อเปลี่ยนผู้รับผิดชอบ) แทนการย้ายงานในหน้านี้โดยตรง
- **ตาราง Module**: คอลัมน์ BA และ Dev หลัก (สีแดงเมื่อ Dev คนเดียวทำ > 85%) ไม่มีใน `insights/modules` · แทนด้วย "ความคืบหน้า" (แถบ %) และ "คาดว่าจะจบ" (วันที่ + ส่วนต่างจากเป้า) · เพิ่ม "Overdue N" ใต้ชื่อ Module
- **รายงานประจำสัปดาห์**: dropdown "ส่งถึง" เป็นข้อความจำนวนผู้รับจาก `report-schedule` (API เลือกผู้รับต่อครั้งไม่ได้) · ปุ่ม "ส่งทาง LINE" กับ "ส่งอีเมล" รวมเป็น "ส่งตอนนี้" ปุ่มเดียว เพราะ `weekly:send` ส่งตามช่องทางที่ตั้งในรอบส่ง · "Export PDF" ใช้ `window.print()` (มี CSS print ซ่อนเมนู) · เพิ่มปุ่ม "แก้ข้อความ" เปิด textarea ของ `text` เพื่อแก้ก่อนคัดลอก (ตาม "แก้ข้อความก่อนส่งได้") · ตารางความเสี่ยง คอลัมน์ "ข้อเสนอ" เป็น "งานที่เกี่ยวข้อง" เพราะ API ไม่มีข้อเสนอ · หัวข้อ 4 แสดงงานใกล้เริ่มที่ยังไม่มีผู้รับผิดชอบ (ตาม A09)
- **Plan vs Actual**: แถบ "Actual จำลอง" เปลี่ยนเป็นคำอธิบายที่มาของ Actual จริง · "Man-Day ใช้จริง" เป็น "Man-Day ที่เสร็จ" (`doneMd`) เพราะยังไม่มี Actual MD ราย Module · เพิ่มกราฟแท่ง Man-Day แผน / เสร็จจริง 8 สัปดาห์ (`weekly` ของ API) เหนือตาราง · ส่วนต่างเทียบ `targetDate` (Milestone ถัดไป ไม่มีใช้ Plan End) และแสดงชื่อ Milestone ใต้ชื่อ Module
- **Traceability**: ชิปเลือก Module เปลี่ยนเป็นชิป ทั้งหมด / FR / NFR + ตัวกรองผลทดสอบ เพราะ API กรองได้ด้วย `kind`, `result` เท่านั้น · คอลัมน์ Man-Day ไม่มีใน `issueDto` จึงแทนด้วย "ผลทดสอบล่าสุด" · คอลัมน์ Screen คำนวณจาก Screen ที่มีงานร่วมกับ Requirement · แถบ "ยังไม่ได้นำเข้า FR" แสดงเมื่อ `requirements.total = 0` ปุ่มไปหน้า Import · KPI "เสร็จแล้ว %" = งานที่ Requirement อ้างถึงที่เสร็จแล้ว
- หน้า Reports เปิดแท็บตาม `?report=weekly|pva|trace` ได้

### คำขอนอก lane

- **W00** (`src/components/shell/project-shell.tsx`): `projectTabs` ยังไม่มีแท็บ Reports (Canvas O1 / O2 มีแท็บ "Reports" ต่อจาก "ภาพรวม (Lead)") · ขอเพิ่ม `{ path: "/reports", label: "reports", permission: "project.reports.view" }` (key `nav.reports` มีใน `common.json` แล้ว) · ตอนนี้เข้าได้จากปุ่ม "สร้างรายงานประจำสัปดาห์" บน Dashboard
- **A09** (ถ้าต้องการให้ตรง Canvas มากขึ้น): `insights/modules` เพิ่ม BA และ Dev หลัก (สัดส่วนงาน) ต่อ Module · `traceability` เพิ่ม `estimateMd` ใน `issueDto` และตัวกรอง `moduleId` · `reports/weekly` เพิ่ม `thisWeek.starting` เพื่อไม่ต้องเรียกรายงานสัปดาห์ก่อนสำหรับ KPI
- **A25**: `weekly:send` ยังสรุปตัวเลขเอง (ดูคำขอใน A09) และไม่รับข้อความที่ผู้ใช้แก้บนหน้า · ถ้าต้องการส่งข้อความที่แก้แล้ว ต้องให้ endpoint รับ `text` ใน body

### ยังไม่ได้ทำ

- ยังไม่ได้เทียบภาพที่ 1440 px / 390 px กับ Canvas (ไม่ได้เปิดเว็บกับ API จริงในรอบนี้)
