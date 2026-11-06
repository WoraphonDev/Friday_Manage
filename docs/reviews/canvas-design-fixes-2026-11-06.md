# ติดตามการแก้ Design ตาม Canvas — 6 พฤศจิกายน 2569

รายการมาจาก [canvas-design-audit-2026-11-06.md](canvas-design-audit-2026-11-06.md) · แก้ตามลำดับที่รายงานแนะนำ (W00 shell ก่อน)

| ID | สถานะ | PR | หมายเหตุ |
|---|---|---|---|
| VD01 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD02 | Codex ตรวจผ่าน desktop; mobile รอ VD04/VD15 | [#79](https://github.com/WoraphonDev/Friday_Manage/pull/79) | [ผลตรวจและภาพ](canvas-vd02-verification-2026-11-06.md) |
| VD03 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD04 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD05 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD06 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD07 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ยังไม่มีคอลัมน์ FR / Screen (ดูด้านล่าง) |
| VD08 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD09 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD10 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | ดูด้านล่าง |
| VD11 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | ดูด้านล่าง |
| VD12 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | ยังไม่มีผลทดสอบ / Requirement / Screen / Labels (ดูด้านล่าง) |
| VD13 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | ดูด้านล่าง |
| VD14 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | ดูด้านล่าง |
| VD15 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-overview-table | ดูด้านล่าง |
| VD16 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | ดูด้านล่าง |
| VD17 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | รวมการ์ด Kanban บนจอใหญ่ |
| VD18 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | ยังไม่มีแท็บ รายละเอียด / ผลทดสอบ / Commits / คอมเมนต์ ของ M4 |
| VD19 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | ดูด้านล่าง |
| VD20 | ตรงแล้ว (ไม่ต้องแก้) | fix/canvas-pages | การ์ดกลุ่มทีมมีอยู่แล้วใน source ปัจจุบัน · ตรวจภาพเทียบ Profile แล้ว |
| VD21 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | ดูด้านล่าง |
| VD22 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | Canvas K3 ไม่มีช่องเพิ่มวันทำการแยก (ดูด้านล่าง) |
| VD23 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-issue-drawer | เพิ่ม API `DELETE issues/:key?subtasks=keep` |
| VD24 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | รวมแก้ UI-02 (ชื่องานในกระดิ่ง) |
| VD25 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | palette y=128 w=680 |
| VD26 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-pages | ดูด้านล่าง |

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

## VD12 / VD13 · Drawer รายละเอียดงาน (C, D, K2)

- Drawer C/D กว้าง 860 px เริ่มใต้หัวโปรเจกต์ (`--drawer-top` จาก ProjectShell) · K2 Bug กว้าง 920 px เต็มสูง · วัดที่จอกว้าง: x/width/top ตรงตำแหน่งใต้หัวโปรเจกต์
- แถบหัวของ Drawer: breadcrumb (Module pill › กลุ่มงาน › งานแม่ › Key + ป้ายประเภท), ‹ 1/N › สำหรับ Sub-task, Watch · N, คัดลอกลิงก์, ⋯ (ขอเลื่อน Due, ลบงาน), ปิด
- ชื่อ 24 px, สถานะเป็นปุ่มสีตามสถานะ + Mark complete (ย้ายไปสถานะ done แรกของ Workflow) + บรรทัดผู้สร้าง/แก้ไขล่าสุด
- เนื้อหาต่อเนื่องแทน 4 แท็บ: Description, Acceptance criteria / Checklist (แยกหัวข้อ, ปุ่มเลื่อน/ลบแสดงเมื่อชี้, เพิ่มด้วยช่องเส้นประ), Sub-tasks (แถบ % + แถวติ๊กเสร็จ/ผู้รับผิดชอบ/วันที่/สถานะ + พิมพ์แล้ว Enter สร้าง Sub-task), Dependencies (ชิป Blocked by / Blocks · ฟอร์มเปิดจากปุ่ม), Development (`GET issues/:key/git` + ชื่อ branch แนะนำ + Copy), Attachments (`files?target=issue:KEY`), Activity และคอมเมนต์
- การ์ดคุณสมบัติ 240 px แบบ "ชื่อ : ค่า" · ช่องแก้ไขดูเป็นค่าธรรมดาจนชี้/โฟกัส (คง label ไว้ให้โปรแกรมอ่านหน้าจอ) · ตารางแผน/จริง (เริ่ม/จบ) · Progress เป็นแถบ
- Bug (K2): ไม่มี Description ว่าง / Checklist / Sub-task · กล่อง Verify เมื่ออยู่สถานะหลังสถานะทำงานแรก (ผ่าน = สถานะถัดไป, ไม่ผ่าน = กลับสถานะทำงานแรก) · ขั้นตอนทำซ้ำ + ผลที่ควรเป็น (เขียว) / ผลจริง (แดง) คู่กัน · คุณสมบัติ Bug: Severity, Environment, Reporter, Due
- Sub-task (D): rail งานแม่ทางซ้ายพื้นขาว · Module แสดง "จาก Task แม่"
- ภาษา: Priority / Watch แสดงเป็นอังกฤษตาม Canvas (Urgent/High/Medium/Low)
- ยังไม่ทำ: ผลการทดสอบ (Test runs) ใน Sub-task, Requirement / Screen / Labels, ปุ่มเปิดเต็มหน้า

## VD10 / VD11 · ฟอร์มสร้างงาน (B, K1)

- `?new=1` (ปุ่ม + New) เปิด K1 หน้าต่างกลางจอ 860 px: การ์ดประเภท Story/Task/Bug/Spike, Module / Sprint / อยู่ใต้งาน (เลือกแม่ = Sub-task), ชื่อ {ประเภท}, ส่วนเฉพาะประเภท (Bug: Severity เป็นปุ่ม, Environment, Browser, Found in, ขั้นตอน, ผลที่ควรเป็น/ผลจริงคู่กัน), Assignee / Priority / Due / Tester, "รายละเอียดเพิ่มเติม" (สถานะ, BA, Reviewer, แผน, Size, Checklist, Dependency, Sub-task) · สร้างต่ออีกรายการอยู่ซ้ายของ footer
- `?new=1&type=task` (+ Task ใน Table) และสร้าง Sub-task เปิด B Drawer 640 px ใต้หัวโปรเจกต์: หัว "สร้างใหม่" + ปุ่มสลับ Task | Sub-task, Module / Sprint, ชื่อ Task, แถว "ชื่อ : ค่า" (Status, Dev, BA, Reviewer, Priority เป็นปุ่มธง, Plan Start → End, Size เป็นปุ่ม XS–XL + MD), คำอธิบาย
- ช่องบังคับมี * สีแดงด้วย CSS (ชื่อช่องเดิมสำหรับโปรแกรมอ่านหน้าจอ)
- ยังไม่ทำ: Requirement / Labels / Watchers และแถบเครื่องมือ Markdown ของคำอธิบาย

## VD18 · Sub-task บนมือถือ (M4)

- แถบหัวเหลือ breadcrumb + ⋯ + ปิด · คุณสมบัติหลัก (Dev, Priority, แผน/จริง, Progress) อยู่ใต้สถานะก่อนเนื้อหา ที่เหลือกด "คุณสมบัติเพิ่มเติม" · ปุ่มสถานะกว้างเต็มแถว

## VD22 · ขอเลื่อน Due (K3)

- Due ปัจจุบัน → Due ใหม่ ในแถวเดียว, เหตุผล, รายละเอียด, กล่อง "ผลกระทบ (ระบบคำนวณให้)" แต่ละแถวมี ✓ / ! (วันทำการที่เพิ่ม, Workload, งานที่รอ, Milestone, Go-live), ผู้อนุมัติพร้อมช่องทางแจ้ง, footer มีเส้นคั่น
- Canvas K3 ไม่มีช่องกรอกจำนวนวันทำการแยก (รายงาน VD22 ระบุไว้) จึงแสดงจำนวนวันทำการที่เพิ่มในกล่องผลกระทบแทน

## VD23 · ยืนยันลบงาน (P3)

- หัวข้อ "ลบ {Key} {ชื่อ}?" + ประเภท · Module, กล่อง "งานนี้มีข้อมูลที่ผูกอยู่" (Sub-task / เสร็จแล้ว, ไฟล์, Dependency), เลือก "ลบ Sub-task ทั้งหมดด้วย" หรือ "เก็บ Sub-task ไว้ เปลี่ยนเป็น Task เดี่ยว", ปุ่มบอกผล ("ลบ Task และ Sub-task N รายการ" / "ลบเฉพาะ Task")
- API ใหม่: `DELETE w/{ws}/issues/{key}?subtasks=keep` ตัดลูกออกจากแม่ (ใช้ Module / กลุ่มงาน / Sprint ของแม่ถ้าลูกไม่มี) แล้วลบเฉพาะแม่ · Activity `parentId` + event `issue.updated` · กู้คืนแม่ไม่ผูกลูกกลับ · สเปก 03-api มีแต่แบบลบพร้อมลูก จึงยึดหน้าจอ P3 (D99 ควรเพิ่มในสเปก)

## VD14 / VD16 · Home, My Tasks, Inbox บนมือถือ (M5, M2, M3)

- `useIsMobile()` (matchMedia ≤760 px) เลือกหน้าตามือถือแทนการซ่อนด้วย CSS เพื่อไม่ให้เนื้อหาซ้ำใน DOM · ฝั่ง server แสดงแบบจอใหญ่ก่อน
- M5 Home: หัวขาว วันที่ + ทักทาย + ปุ่มค้นหา (เปิด Command palette ผ่าน `openSearch` ใน Workspace context), KPI 3 ช่อง (Overdue ทีม / วันนี้ / รอฉัน Review), การ์ด "รอคุณอนุมัติ" มีปุ่มปฏิเสธ / อนุมัติ, "วันนี้ของฉัน" มีแถบสีซ้าย, โปรเจกต์เลื่อนแนวนอน
- M2 My Tasks: หัว "My Tasks · ชื่อ" + ค้นหา + ตัวกรอง (เปิดแท็บ มอบหมาย / Reviewer / …), ชิป วันนี้ + Overdue / สัปดาห์นี้ / ทั้งหมด พร้อมจำนวน, กลุ่มตาม Due, แถวกะทัดรัด (checkbox 24 px, ชื่อ, Key · โปรเจกต์, วันที่สีตามสถานะ), ปุ่มสร้างลอย
- M3 Inbox: หัว Inbox + "Mark all as read" เป็นลิงก์ (Canvas มือถือใช้ "อ่านทั้งหมด" แต่จอใหญ่ใช้ Mark all as read จึงคงข้อความเดียว), ชิป ทั้งหมด / มอบหมาย / Mention
- ยังไม่ทำ: ปัดซ้าย/ขวาบนรายการ My Tasks

## VD17 · Kanban (M7 และจอใหญ่)

- การ์ด: แถวบน = ไอคอนประเภท, Key, Module pill, ธง Priority · งานแม่ · ชื่อ · วันที่ / Sub-task / คอมเมนต์ / ผู้รับผิดชอบ · ปุ่มย้ายแสดงเมื่อชี้หรือโฟกัส
- หัวคอลัมน์มี WIP (แดงเมื่อเกิน) และปุ่ม + · แถวแรกเป็นชิป Module + งานของฉัน / Overdue แถวสองเป็น แสดง / Swimlane / Reset
- มือถือ: ชื่องานขึ้นก่อน, ผู้รับผิดชอบ + วันที่ + "ย้ายไป…" แถวเดียว, ไม่มีลูกศร · ปุ่มตัวกรองอยู่ท้ายแถวชิปคอลัมน์

## VD19 · ปุ่มท้ายหน้าบนมือถือ

- `workspace-main` เว้นที่ล่าง 56 px + safe area ทุกหน้าที่มีเมนูล่าง ปุ่มท้ายหน้า (เช่น Import step 2) ไม่ถูกบัง

## VD21 · Invite dialog (H)

- Dialog ขนาด medium 680 px มีเส้นใต้หัวและ footer · Role 3 การ์ดแถวเดียว · โปรเจกต์เป็นรายการติ๊กพร้อมบทบาทด้านขวา (API รับครั้งละ 1 โปรเจกต์ จึงติ๊กได้ทีละรายการ)

## VD24 · Toast แจ้งเตือน (K4)

- Toast รองรับ `actor`, `meta`, `actions` (ลิงก์) · แสดงพื้นเข้ม รูป + ชื่อ + ข้อความ + บรรทัดรอง + ปุ่มขาวหลัก
- กระดิ่ง: เมื่อมีแจ้งเตือนใหม่ดึงรายการล่าสุดแล้วแสดง Toast: คำขอเลื่อน Due = "อนุมัติ / ดูรายละเอียด" (ไป Inbox), งานอื่น = "เปิดงาน" + "ดูภายหลัง" · ดึงไม่ได้ใช้ข้อความนับแบบเดิม · ไม่มีปุ่มที่ทำงานแทนสิทธิ์ (หน้าเป้าหมายตรวจสิทธิ์เอง)
- แก้ UI-02: กระดิ่งอ่าน `payload.issueTitle` ก่อน `title`

## VD25 / VD26

- Command palette top 128 px (เดิม 72)
- New Project: ขนาดคอลัมน์ตาม Canvas (ขั้นตอน 220–260 / ฟอร์ม 520+ / สรุป 260–320), ช่องชื่อและคำอธิบายเต็มแถว · Template 3 + 1 ที่ 1440 px

## รอบไล่เทียบทุกหน้า (หลัง VD01–VD26)

เทียบภาพจริงกับ Canvas ที่ 1440 px ทีละหน้า แล้วแก้ส่วนที่ยังต่าง

- Timeline: แกนเวลา 3 แถว (เดือน / วันที่ของสัปดาห์ / เลขสัปดาห์ ISO + Sprint ปัจจุบัน), ซูมเริ่มต้นเป็นสัปดาห์, ปุ่มระดับ Module / + Task / + Sub-task, เลือกสีตาม, ลิงก์ + Milestone, จำนวนงานต่อแถว, ลิงก์เพิ่มงาน, ป้ายชื่อขวาของแถบ
- Calendar: มุมมอง เดือน / สัปดาห์ / วัน / Agenda, แถบเครื่องมือ 2 แถว + ปุ่มตัวกรอง, การ์ด "ยังไม่ได้ลงวัน" ลากลงวันเพื่อตั้ง Plan Start/End
- Files: ที่เก็บเสมือน ทั้งหมด / ล่าสุด / แนบในงาน / แยกตามชนิด, ค่าเริ่มต้นเป็น "ทั้งหมด"
- Members: แถบภาระงานเต็มความกว้าง · Backlog: ปุ่มเริ่ม Sprint สีเขียว · Workflow: ที่จับลาก, สีของสถานะ, ปุ่มเรียงแสดงเมื่อชี้
- Lead (O1/O2): แท็บเฉพาะที่ Lead ใช้, ปุ่ม "สร้างรายงานประจำสัปดาห์" และ Import / Export บนหัว, แถบบนไม่มีค้นหาและ + New
- Priority ภาษาไทยใช้คำอังกฤษ Urgent / High / Medium / Low ตาม Canvas
- My Tasks: ธง Priority และปุ่ม "+ งานใหม่" · แถบบนมี + New ทุกหน้า Workspace (สร้างในโปรเจกต์แรก)
- Inbox: ชื่อตัวกรองตาม Canvas (มอบหมาย / Review, Mentions, ความเคลื่อนไหวของงาน, กำหนดส่ง)
- Search (P1): ไม่มี Sidebar, พิมพ์คำค้นที่แถบบน (มือถือใช้ช่องในหน้า), รายการผลต่อกันไม่มีหัวกลุ่ม (คงกลุ่มไว้ให้โปรแกรมอ่านหน้าจอ)
- Reports (O2): หัวมีแค่ไอคอนกับชื่อ, รายการในรายงานมีจุดนำ
- Gantt: แถบเครื่องมือ 2 แถว (มุมมอง / แผน) และปุ่ม Export PDF (พิมพ์หน้า)
- Automation: breadcrumb มีชื่อโปรเจกต์, กว้างสุด 1360 px กลางจอ
- Admin Console: เมนูซ้ายเป็นแถบขาวเต็มความสูงพร้อมชื่อ Workspace และแพ็กเกจ, KPI 5 ช่องมีแถบใช้ไป (ผู้ใช้ / พื้นที่), "ต้องดำเนินการ" กับกราฟผู้ใช้อยู่แถวเดียวกัน
- Import: ไม่มี Sidebar ตาม Canvas L1
- Project Settings: หัวมีชื่อ สถานะ และ "เฉพาะ Admin ของโปรเจกต์แก้ไขได้"
- Sidebar: "+ New project" เป็นเมนูที่เลือกอยู่เมื่ออยู่หน้าสร้างโปรเจกต์

ตรวจแล้วตรงกับ Canvas: Home, Inbox, Login, Landing, Profile, New Project, Workspace members, Notify templates

ยังต่างโดยตั้งใจหรือรอข้อมูล
- Import: ไม่มีปุ่ม "ดาวน์โหลด Template" เพราะยังไม่มี endpoint ของไฟล์ Template
- Reports: ไม่มีปุ่ม "ส่งทาง LINE" และตัวเลือก "ส่งถึง" แบบหลายกลุ่ม (ส่งตามรอบที่ตั้งไว้)
- ปุ่มภาษาแสดง "English" (ชื่อภาษาของตัวเอง) แทน "EN"
- Canvas ใช้ทั้ง "ภาพรวม Lead" (16 ไฟล์) และ "ภาพรวม (Lead)" (2 ไฟล์) จึงคงแบบที่ใช้มากกว่า

## เลือกต่างจาก Canvas: Sidebar และแท็บคงที่ทุกหน้า (2026-11-07)

ผู้ใช้ลองใช้จริงแล้วพบว่า Sidebar หายและแท็บเปลี่ยนจำนวน / ขยับเมื่อกดไป ภาพรวม Lead หรือ Reports จึงเลือกให้กรอบหน้าเหมือนกันทุกหน้า

- Sidebar แสดงทุกหน้าของ Workspace รวม ภาพรวม Lead, Reports, Automation, Search, Import (ยกเลิกกรอบ focus ของ VD03) · Admin Console และหน้าชำระเงินยังใช้กรอบของตัวเอง
- หัวโปรเจกต์และแท็บชุดเดียวกันทุกแท็บ: ยกเลิกชุดแท็บเฉพาะ Lead, หัวแบบสั้นของ Reports และ Project Settings · แถบบนมีค้นหาและ + New ทุกหน้า
- ปุ่ม "สร้างรายงานประจำสัปดาห์" และ Import / Export กลับไปอยู่ในแถบเครื่องมือของ ภาพรวม Lead
- Timeline: ป้าย "สัปดาห์ · Sprint" ไม่ทับเลขสัปดาห์ถัดไป และป้าย Milestone ที่อยู่ใกล้กันตัดด้วย … (ชื่อเต็มอยู่ใน tooltip) · พบเมื่อลองกับแผนที่มีหลาย Milestone
- Timeline: หัวแกนเหมือน Gantt ตามที่ผู้ใช้เลือก (Day / Week / Month สเกลเดียวกับ Gantt · แถวบนเป็นช่วงสัปดาห์หรือเดือน · Day แสดงทุกวันพร้อมตัวย่อวัน · แรเงาเสาร์-อาทิตย์) แทนแกน 3 แถวของ Canvas
- Timeline: แกนเวลาเต็มเดือน (เริ่มวันที่ 1 ของเดือนแรก จบสิ้นเดือนสุดท้าย) และยาวอย่างน้อยเต็มจอ, Key ของงานไม่ตัดบรรทัด, ป้ายของแถบอยู่เหนือเส้นวันนี้


## ผลตรวจ Codex

VD02 ผ่านตามขอบเขต desktop; อีก25รายการยังเปิดอยู่ ดู [ผลตรวจซ้ำ](canvas-vd02-verification-2026-11-06.md) และภาพ1440/390px ตัวเลขมือถือของ fixture ที่ Codexใช้คือ200px ไม่ใช่175px; Canvas M6ยังต้องแก้ใน VD04/VD15 ส่วนชื่อยาวมีพฤติกรรม wrap ใน Canvasเช่นกัน ไม่บังคับความสูง125pxกับทุกชื่อ
