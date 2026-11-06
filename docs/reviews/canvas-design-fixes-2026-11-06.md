# ติดตามการแก้ Design ตาม Canvas — 6 พฤศจิกายน 2569

รายการมาจาก [canvas-design-audit-2026-11-06.md](canvas-design-audit-2026-11-06.md) · แก้ตามลำดับที่รายงานแนะนำ (W00 shell ก่อน)

| ID | สถานะ | PR | หมายเหตุ |
|---|---|---|---|
| VD02 | แก้แล้ว รอ Codex ตรวจภาพ | fix/canvas-project-header | ดูด้านล่าง |

## VD02 · Project header

- ชื่อ, สถานะ, Health และวันที่อยู่แถวเดียว · ไอคอน 32 px แสดง 2 ตัวแรกของ Key · ทางขวามี Avatar stack (สมาชิกที่ active สูงสุด 5 คน), Invite, เมนู ⋯ และ + New
- วัดที่ 1440 px: header สูง 124.53 px และแท็บเริ่มที่ y 135.97 ตรงกับ Canvas Main ทุกค่า (เดิม 152 px)
- Health ใช้ `overview?scope=all` ด้วย queryKey เดียวกับหน้า Overview · ทีมใช้ `projects/{key}/members` queryKey เดียวกับหน้า Members · Guest Viewer ไม่โหลดทีม
- Invite ไปที่ `members#invites` (แสดงเมื่อ `canInvite`) · เมนู ⋯ มี Settings, Automation, การแก้ไขแผน ตามสิทธิ์ เพราะสองหน้าหลังไม่มีแท็บของตัวเอง
- แท็บสมาชิกแสดง "Members" ตาม Canvas (เมนูซ้ายยังเป็น "สมาชิก") · คงแท็บ Reports ไว้ตามที่ W15 ขอจาก Canvas O1/O2
- มือถือ 390 px: ซ่อน Avatar, Invite และ ⋯ (หน้าในเมนูเปิดบนจอใหญ่เท่านั้น), breadcrumb บรรทัดเดียว · header 175 px (เดิม 168.5 px เพิ่มเพราะ Health) · หัวแบบ M6 127 px เป็นงาน VD15
- ยังไม่ทำในรอบนี้: header เฉพาะบริบทของ Lead/Reports/Automation (VD03)
