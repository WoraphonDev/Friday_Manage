# ติดตามการแก้ Design ตาม Canvas — 6 พฤศจิกายน 2569

รายการมาจาก [canvas-design-audit-2026-11-06.md](canvas-design-audit-2026-11-06.md) · แก้ตามลำดับที่รายงานแนะนำ (W00 shell ก่อน)

| ID | สถานะ | PR | หมายเหตุ |
|---|---|---|---|
| VD01 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD02 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-project-header | ดูด้านล่าง |
| VD03 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD04 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD05 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD06 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD07 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ยังไม่มีคอลัมน์ FR / Screen (ดูด้านล่าง) |
| VD08 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD09 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD15 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |

## VD02 · Project header

- ชื่อ, สถานะ, Health และวันที่อยู่แถวเดียว · ไอคอน 32 px แสดง 2 ตัวแรกของ Key · ทางขวามี Avatar stack (สมาชิกที่ active สูงสุด 5 คน), Invite, เมนู ⋯ และ + New
- วัดที่ 1440 px: header สูง 124.53 px และแท็บเริ่มที่ y 135.97 ตรงกับ Canvas Main ทุกค่า (เดิม 152 px)
- Health ใช้ `overview?scope=all` ด้วย queryKey เดียวกับหน้า Overview · ทีมใช้ `projects/{key}/members` queryKey เดียวกับหน้า Members · Guest Viewer ไม่โหลดทีม
- Invite ไปที่ `members#invites` (แสดงเมื่อ `canInvite`) · เมนู ⋯ มี Settings, Automation, การแก้ไขแผน ตามสิทธิ์ เพราะสองหน้าหลังไม่มีแท็บของตัวเอง
- แท็บสมาชิกแสดง "Members" ตาม Canvas (เมนูซ้ายยังเป็น "สมาชิก") · คงแท็บ Reports ไว้ตามที่ W15 ขอจาก Canvas O1/O2
- มือถือ 390 px: ซ่อน Avatar, Invite และ ⋯ (หน้าในเมนูเปิดบนจอใหญ่เท่านั้น), breadcrumb บรรทัดเดียว · header 175 px (เดิม 168.5 px เพิ่มเพราะ Health) · หัวแบบ M6 127 px เป็นงาน VD15
- ยังไม่ทำในรอบนี้: header เฉพาะบริบทของ Lead/Reports/Automation (VD03)

## VD01 · Sidebar

- กว้าง 220 px (Canvas 220.7 px) · Admin Console และแพ็กเกจฯ ย้ายไปล่างสุดคั่นด้วยเส้นตาม Canvas · ชื่อโปรเจกต์ยาวขึ้นบรรทัดใหม่แทนการตัด
- คง "นำเข้าแผน" ไว้ใต้ + New project (Canvas ไม่มี แต่เป็นทางเข้า L3 ที่ใช้อยู่)

## VD03 · กรอบหน้าตามบริบท

- `shellChrome()` เลือกกรอบจาก URL: `focus` (Lead, Reports, Automation) ไม่มี Sidebar · `admin` top bar มีป้าย Admin Console + "← กลับไปที่ Workspace" ไม่มีค้นหา/กระดิ่ง/Sidebar · `checkout` หัวขาว "ชำระเงิน · Workspace" + เชื่อมต่อแบบเข้ารหัส ไม่มีเมนู
- Automation ไม่แสดงหัวโปรเจกต์ (หน้ามี breadcrumb เอง) · Lead/Reports ไม่มี breadcrumb, ทีม, Invite, ⋯, + New ตาม O1
- หน้าชำระเงินเอาหัวข้อและข้อความเข้ารหัสที่ซ้ำกับหัวออก คง h1 แบบ sr-only
- ยังต่างจากแบบ: แท็บของ O1 ใน Canvas มีชุดย่อย (ไม่มี Overview/Timeline/Calendar/Files) แต่ยังใช้ชุดเต็มเพื่อไม่ตัดทางไปหน้าอื่น · ปุ่มประจำหน้าของ Lead ยังอยู่ในเนื้อหา (W15)

## VD04 · มือถือ

- ≤760 px ซ่อน top bar มืดของหน้าทั่วไป · เมนูล่าง 5 รายการตาม M5: Home, My Tasks, Projects, Inbox (ตัวนับ), Profile (Avatar) · รายการที่เลือกเป็นตัวหนาสีน้ำเงินไม่มีพื้น
- ค้นหา, สลับ Workspace, ภาษา และออกจากระบบ ย้ายไปอยู่ในเมนู Projects เพราะมือถือไม่มี top bar แล้ว
- หัวโปรเจกต์มือถือมีปุ่มกลับ + ไอคอน + ชื่อบรรทัดเดียว สถานะ/วันที่บรรทัดที่สอง ไม่มี breadcrumb (header 165 px · M6 127 px ส่วนที่เหลือเป็นชุดแท็บ/summary ของ VD15)
- ปุ่มค้นหาในหัวของ Home / My Tasks ตาม M2/M5 เป็นงานของหน้า (VD14, VD16)

## VD05 / VD06 · Overview

- การ์ดสรุปเดียวตาม Main: วงความคืบหน้า, แถบเวลา/งานที่เสร็จ, Go-live, Milestone ถัดไป และกล่อง Health ตามระดับ (แดง/เหลือง/เขียว) เต็มแถว
- KPI 4 การ์ดแยก มีจุดสี ตัวเลข 34 px และ ▲/▼ เทียบสัปดาห์ก่อน · ชื่อ Overdue / Due today / Later this week / Done in 7 days ตาม Canvas
- รายการมี checkbox ปิดงาน (ใช้สถานะ Done ของประเภทงานพร้อม version ล่าสุด แบบ My Tasks), แถวที่สอง Module pill + Key/แม่/กลุ่มงาน, วันที่สีตามรายการ, ลิงก์ "ดูทั้งหมด N งาน"
- ข้อมูลโปรเจกต์อยู่ใต้กราฟคอลัมน์ซ้าย (มีปุ่มแก้ไขไป Settings) · คอลัมน์ขวา: Progress by Module, Status breakdown, Milestones, Workload, Recent activity · กราฟใช้ชื่อวันแบบย่อ
- ยังต่างจากแบบ: "อัปเดตล่าสุด" ใช้เวลาที่โหลดข้อมูล · แถวเอกสาร (SRS/BRD) ยังไม่มีข้อมูลใน API

## VD07 / VD08 / VD09 · Table

- Views: All tasks, งานของฉัน, Overdue + View ที่บันทึก · แถบเครื่องมือ: ค้นหา, Filter (Status / Priority / ระดับ พร้อมตัวนับ), Group by (Module › กลุ่มงาน / Status / Assignee / Priority / None), BA, Dev, Size, Sort (Manual = rank), Columns, Show completed · ขวา: Expand/Collapse all, Import / Export Excel, + Module, + Task
- Status เป็น pill ที่กดแล้วเลือกได้ · Plan End เป็นข้อความกดแล้วเป็นช่องวันที่ · ไม่มีคอลัมน์ Priority (แก้ใน Drawer) · Actual แสดง "จบ … · ช้า N วัน"
- แถว Module สูง 52 px มีแถบ % และช่วงแผน + "+ Task" · แถวกลุ่มงานมีป้าย "กลุ่มงาน" + เสร็จ/ทั้งหมด + MD และย่อได้ · แถว "+ เพิ่ม Task ใน …" และสรุปท้าย Module · ปุ่ม "+ เพิ่ม Module ใหม่"
- แถบเลือกหลายแถวอยู่เหนือตาราง ปุ่ม Status / Assignee / Due date / ย้าย Module / Delete / ยกเลิกการเลือก · Status หลายงานแก้ทีละงานพร้อม version เพราะ bulk API ไม่รับ statusId
- Size กรองฝั่งเว็บ (API ยังไม่มีตัวกรอง Size)
- ยังไม่ทำ: คอลัมน์ FR / Screen และ View Sprint / Backlog ใน Canvas เพราะยังไม่มีข้อมูลอ้างอิง Requirement ในแถวของ API

## VD15 · Mobile Overview + หัวโปรเจกต์มือถือ

- มือถือแสดงการ์ดสรุป M6 (ระดับ Health, % ใหญ่, แถบพร้อมเส้นเวลา, Overdue / Bug เปิด / รออนุมัติ จาก `counts`), Milestone ถัดไป, ความเสี่ยง (สร้างจาก Health / Module / counts) แล้วตามด้วย Module และ Workload · ซ่อนการ์ด desktop
- หัวโปรเจกต์มือถือตาม M6/M7: ปุ่มกลับ + ไอคอน + ชื่อ + บรรทัดรายละเอียด + ⋯ (มี + New) · แท็บ Overview, Kanban, List, Calendar, Files
