# ติดตามการแก้ Design ตาม Canvas — 6 พฤศจิกายน 2569

รายการมาจาก [canvas-design-audit-2026-11-06.md](canvas-design-audit-2026-11-06.md) · แก้ตามลำดับที่รายงานแนะนำ (W00 shell ก่อน)

| ID | สถานะ | PR | หมายเหตุ |
|---|---|---|---|
| VD01 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD02 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-project-header | ดูด้านล่าง |
| VD03 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |
| VD04 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-shell-variants | ดูด้านล่าง |

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
