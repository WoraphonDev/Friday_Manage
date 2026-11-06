# ติดตามการแก้ Design ตาม Canvas — 6 พฤศจิกายน 2569

รายการมาจาก [canvas-design-audit-2026-11-06.md](canvas-design-audit-2026-11-06.md) · แก้ตามลำดับที่รายงานแนะนำ (W00 shell ก่อน)

| ID | สถานะ | PR | หมายเหตุ |
|---|---|---|---|
| VD01 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD02 | Codex ตรวจผ่าน desktop; mobile รอ VD04/VD15 | [#79](https://github.com/WoraphonDev/Friday_Manage/pull/79) | [ผลตรวจและภาพ](canvas-vd02-verification-2026-11-06.md) |
| VD03 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD04 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD05 | ยังไม่แก้ | — | Overview summary เปลี่ยนจากการ์ดรวมเป็น 5 การ์ด |
| VD06 | ยังไม่แก้ | — | Overview KPI/list/ข้อมูลโปรเจกต์จัดใหม่คนละโครง |
| VD07 | ยังไม่แก้ | — | Table toolbar ขาดชุดควบคุมในแบบ |
| VD08 | ยังไม่แก้ | — | Table ใช้ native select ทุกแถวและสลับชุดคอลัมน์ |
| VD09 | ยังไม่แก้ | — | Table bulk bar และ action ของแถวอยู่ผิดตำแหน่ง |
| VD10 | ยังไม่แก้ | — | Task create drawer ใช้กรอบเดียวกับ detail และ form arrangement ต่าง |
| VD11 | ยังไม่แก้ | — | สร้าง Bug/Story/Spike ใช้ drawer แทน centered modal |
| VD12 | ยังไม่แก้ | — | Task/Bug detail เปลี่ยน information architecture |
| VD13 | ยังไม่แก้ | — | Sub-task มี parent navigation ซ้ำและ rail/พื้นที่เนื้อหาต่าง |
| VD14 | ยังไม่แก้ | — | Mobile Home ยังเป็น desktop ที่ยุบคอลัมน์ |
| VD15 | ยังไม่แก้ | — | Mobile Overview ไม่ใช้ summary compact ของ M6 |
| VD16 | ยังไม่แก้ | — | Mobile My Tasks/Inbox ไม่ใช้โครง toolbar และ list ของ M2/M3 |
| VD17 | ยังไม่แก้ | — | Mobile Kanban toolbar/card actions ต่างจาก M7 |
| VD18 | ยังไม่แก้ | — | Mobile Sub-task properties ดันเนื้อหาหลักพ้นจอ |
| VD19 | ยังไม่แก้ | — | Import บนมือถือ: เมนูล่างบังปุ่มถัดไปจนแตะไม่ได้ |
| VD20 | ยังไม่แก้ | — | Profile notification connections ขาดการ์ดกลุ่มทีม |
| VD21 | ยังไม่แก้ | — | Invite dialog ใช้ controls/สัดส่วนต่างจาก H |
| VD22 | ยังไม่แก้ | — | Due request dialog ขาดตัวเพิ่มวันและจัดส่วนผลกระทบต่าง |
| VD23 | ยังไม่แก้ | — | Delete confirmation ไม่มีตัวเลือกจัดการ Sub-task ตาม P3 |
| VD24 | ยังไม่แก้ | — | Notification toast ไม่รองรับ action ใน Canvas K4 |
| VD25 | ยังไม่แก้ | — | Command palette อยู่สูงกว่าแบบ 56 px |
| VD26 | ยังไม่แก้ | — | New Project template choices จัด grid ต่างจาก A |

## VD02 · Project header

- ชื่อ, สถานะ, Health และวันที่อยู่แถวเดียว · ไอคอน 32 px แสดง 2 ตัวแรกของ Key · ทางขวามี Avatar stack (สมาชิกที่ active สูงสุด 5 คน), Invite, เมนู ⋯ และ + New
- วัดที่ 1440 px: header สูง 124.53 px และแท็บเริ่มที่ y 135.97 ตรงกับ Canvas Main ทุกค่า (เดิม 152 px)
- Health ใช้ `overview?scope=all` ด้วย queryKey เดียวกับหน้า Overview · ทีมใช้ `projects/{key}/members` queryKey เดียวกับหน้า Members · Guest Viewer ไม่โหลดทีม
- Invite ไปที่ `members#invites` (แสดงเมื่อ `canInvite`) · เมนู ⋯ มี Settings, Automation, การแก้ไขแผน ตามสิทธิ์ เพราะสองหน้าหลังไม่มีแท็บของตัวเอง
- แท็บสมาชิกแสดง "Members" ตาม Canvas (เมนูซ้ายยังเป็น "สมาชิก") · คงแท็บ Reports ไว้ตามที่ W15 ขอจาก Canvas O1/O2
- มือถือ 390 px: ซ่อน Avatar, Invite และ ⋯ (หน้าในเมนูเปิดบนจอใหญ่เท่านั้น), breadcrumb บรรทัดเดียว · header 175 px (เดิม 168.5 px เพิ่มเพราะ Health) · หัวแบบ M6 127 px เป็นงาน VD15
- ยังไม่ทำในรอบนี้: header เฉพาะบริบทของ Lead/Reports/Automation (VD03)

## ผลตรวจ Codex

VD02 ผ่านตามขอบเขต desktop; อีก25รายการยังเปิดอยู่ ดู [ผลตรวจซ้ำ](canvas-vd02-verification-2026-11-06.md) และภาพ1440/390px ตัวเลขมือถือของ fixture ที่ Codexใช้คือ200px ไม่ใช่175px; Canvas M6ยังต้องแก้ใน VD04/VD15 ส่วนชื่อยาวมีพฤติกรรม wrap ใน Canvasเช่นกัน ไม่บังคับความสูง125pxกับทุกชื่อ

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
