# W23 · เว็บ: ถังขยะ กู้คืนโปรเจกต์ และหน้า Workspace ที่ลบไว้

| | |
|---|---|
| Wave | O-3 (เฟส 1) · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | A41 |
| Lane (แก้ได้เฉพาะ) | `apps/web/src/features/trash/**` · `apps/web/messages/th/trash.json` · `apps/web/app/work/[ws]/admin/_components/admin-console.tsx` (เพิ่มเมนูถังขยะเท่านั้น) · `apps/web/app/work/[ws]/p/[key]/settings/_components/project-settings.tsx` (เพิ่มแท็บถังขยะเท่านั้น) |
| หน้าจอ | `design/proposals/phase3/05-restore-data.html` › Z1 ถังขยะ · Z2 กู้คืนโปรเจกต์ · Z3 ลบถาวร · Z4 ถังขยะของโปรเจกต์ · Z5 Workspace ที่ลบไว้ |
| สเปก | [03-api](../spec/03-api.md) › 3.8 · [04-permissions](../spec/04-permissions.md) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

- Admin Console › ถังขยะ (Z1): แท็บโปรเจกต์ / งาน / ไฟล์ · ค้นหา · กรองโปรเจกต์และผู้ลบ · เลือกหลายแถว · "เลือกทั้งชุด" · กู้คืน · ลบถาวร (Owner) · เหลือ ≤ 3 วันเป็นสีแดง
- Project Settings › ถังขยะ (Z4) สำหรับสิทธิ์ `project.trash` · ตารางเดียวกันที่กรองโปรเจกต์ไว้ · มือถือเป็นการ์ด
- Dialog กู้คืนโปรเจกต์ (Z2) พร้อมกรณี Key ซ้ำ และเกินแพ็กเกจ (ใช้ PlanLimitDialog เดิม) · ลบถาวร (Z3 ระดับ 3 ของ P3)
- หน้า Workspace ที่ลบไว้ (Z5): Owner กู้คืนและส่งออกข้อมูล · สมาชิกเห็นข้อความให้ติดต่อ Owner · ตัวสลับ Workspace มีส่วน "ลบไว้ · กู้คืนได้" จาก `GET workspaces/deleted` ที่มีอยู่
- ข้อความทั้งหมดใน namespace `trash` · ภาษาอังกฤษให้ W21
- **คำขอนอก lane:** `src/components/shell/workspace-shell.tsx` (ไฟล์กลางของ W00) เพิ่มส่วน "ลบไว้" ในตัวสลับ และแสดง Z5 แทนเนื้อหาเมื่อ Workspace อยู่ในสถานะลบ · งานนี้เป็นงานแรกในชุดที่แตะไฟล์นี้ ให้เพิ่มเป็นช่อง (slot) สั้น ๆ เพื่อให้ W24–W26 ต่อได้โดยไม่ชนกัน

## เสร็จเมื่อ

- [ ] หน้าตรงกับข้อเสนอที่อนุมัติแล้วที่ 1440 px · ที่ 390 px ใช้งานได้
- [x] ครบทุกสถานะตาม M1 (กำลังโหลด · ถังขยะว่าง · Error พร้อม requestId · ไม่มีสิทธิ์) · ซ่อนปุ่มตาม `my-permissions`
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] build และ deploy Docker เว็บ (และ API ของ A41) ในเครื่องตาม CLAUDE.md แล้วลบ / กู้คืนจริงผ่าน http://localhost:3000

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **ทำก่อนเปิดตัวหรือไม่** · **แนะนำ:** ทำก่อนเปิดตัว (เฟส 1 ตาม ComingSoon) เพราะตอนนี้ข้อความหลังลบโปรเจกต์บอกลูกค้าว่า "กู้คืนได้ภายใน N วัน" แต่ไม่มีทางกู้
- **ที่วางถังขยะ** ทั้ง Admin Console (ระดับ Workspace) และ Project Settings (ระดับโปรเจกต์) · **แนะนำ:** ทั้งสองที่ เพราะโปรเจกต์ที่ลบเปิดไม่ได้แล้ว และ Project Admin ไม่ได้เป็น Admin ของ Workspace เสมอ

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · ใช้ API ของ A41 (`w/trash`, `w/projects/:key/trash`, `w/trash/{issue|file}:restore`, `w/trash/project/{id}:restore`, `w/trash/{type}:purge`, `workspaces/deleted`, `workspaces/:slug/deleted`, `workspaces/:slug/deleted/exports`, `workspaces/:slug/restore`)

**ทำแล้ว** (`apps/web/src/features/trash/**` · namespace `trash`)
- `TrashBrowser` ตารางเดียวใช้ทั้ง Z1 และ Z4: แท็บแบบ segmented พร้อมจำนวน · ค้นหา (หน่วง 250 ms) · กรองโปรเจกต์ (เฉพาะ Z1) และผู้ลบ · เลือกหลายแถว / เลือกทั้งหน้า · แถบที่เลือก (รวม Sub-task) · กู้คืน / ลบถาวร · แถบ "ลบ N งาน… · เลือกทั้งชุด" จาก `batches` · เหลือ ≤ 3 วันเป็นป้ายแดง · "โหลดเพิ่ม" ตาม `nextCursor` · สถานะ M1 ครบ (กำลังโหลด · ถังขยะว่าง · ไม่พบตามตัวกรอง + ล้างตัวกรอง · Error พร้อม requestId · 403 ไม่มีสิทธิ์) · ≤ 760 px เปลี่ยนตารางเป็นการ์ด (Z4)
- Z1: เมนู "ถังขยะ" (ป้าย "ใหม่") ท้ายกลุ่ม "ความปลอดภัย & การกำกับ" ของ Admin Console · Owner / Admin เท่านั้น (สมาชิกไม่เรียก API) · ปุ่มลบถาวรตาม `can.purge` (Owner)
- Z2 `RestoreProjectDialog`: สิ่งที่กลับมา (งาน / ไฟล์ / สมาชิก) · Key ซ้ำ (จาก `keyTaken` ในรายการ หรือ 409 `project_key_taken` / `key_taken`) แสดงโปรเจกต์ที่ใช้ Key และช่อง Key ใหม่ (เติม MKT2 ไว้ก่อน · ชนอีกครั้งใช้ `suggestedKey` ของ API · ตรวจ `^[A-Z][A-Z0-9]{1,9}$`) · 402 ปิด Dialog แล้วให้ `PlanLimitHost` เดิมแสดง Q2
- Z3 `PurgeDialog`: รายการที่จะลบ + Sub-task · คำเตือน · พิมพ์ "ลบถาวร" · ใช้ `POST w/trash/{type}:purge` ครั้งเดียวทุกรายการ
- Z4: แท็บ "ถังขยะ" ใน Project Settings แสดงเมื่อ `my-permissions` มี `project.trash` (ไม่ใช่ Guest) · เปิดตรงโดยไม่มีสิทธิ์ได้หน้าไม่มีสิทธิ์โดยไม่เรียก API · ไม่มีคอลัมน์โปรเจกต์และปุ่มลบถาวร (API ตอบ `can.purge: false`)
- Z5 `DeletedWorkspaceScreen`: shell เห็นว่า slug ไม่อยู่ใน `me/workspaces` → ถาม `GET workspaces/:slug/deleted` · 200 = แทนทุกหน้าด้วย Z5 (แถบบนมีโลโก้ + บัญชี) · 404 = "ไม่พบ" เหมือนเดิม · Owner: ผู้ลบ วันลบถาวร (อีก N วัน) จำนวนโปรเจกต์ / งาน / พื้นที่ / สมาชิก แพ็กเกจ · ส่งออกข้อมูลก่อนลบ (ถามสถานะทุก 3 วิจนพร้อม แล้วเป็นปุ่มดาวน์โหลด) · กู้คืนแล้ว shell โหลด `me/workspaces` ใหม่และเข้าหน้าเดิมได้ทันที · สมาชิก: ข้อความติดต่อ Owner (ชื่อ · อีเมล) + ไปที่ Workspace อื่น
- ตัวสลับ Workspace (popover และเมนูมือถือ) มีส่วน "ลบไว้ · กู้คืนได้" พร้อมป้ายวันที่เหลือ จาก `GET workspaces/deleted` (Owner) · ไม่มีรายการ = ไม่แสดงส่วนนี้

**ต่างจากหน้าจอที่อนุมัติ**
- คำอธิบาย Z1 ชี้ไป "ข้อมูล & PDPA › ถังขยะ" (ที่ตั้งค่า 30 / 90 วันอยู่จริงใน Admin Console) แทน "ความปลอดภัย & SSO › ถังขยะ" และเป็นลิงก์
- Key ใหม่ใน Z2 ใช้กติกาของ API (2–10 ตัว) แทน "2–6 ตัว" ในภาพ
- Z3 ไม่แสดง "ไฟล์แนบ 12 ไฟล์ (84 MB)" เพราะลบงานถาวรไม่ลบไฟล์ที่แนบ (ไฟล์เป็นของโปรเจกต์ · ตัดสินใน A41)
- แท็บโปรเจกต์ใน Z1 กู้คืนทีละโปรเจกต์ (ต้องผ่าน Dialog Z2) · เลือกหลายโปรเจกต์ได้เฉพาะลบถาวร
- Z5 ลิงก์ "ส่งคำขอลบข้อมูล (PDPA)" ไปหน้า `/legal/privacy` เพราะหน้าคำขอ PDPA อยู่ใต้ Workspace ซึ่งเข้าไม่ได้ระหว่างลบ · ปุ่ม "ไปที่ Workspace อื่น" ไป Workspace แรกที่ใช้งานได้ (ไม่มี = สร้าง Workspace)
- มือถือ: การ์ดของ Z1 / Z4 ไม่มีช่องเลือก (กู้ทีละรายการ หรือ "เลือกทั้งชุด") · ข้อความภาษาอังกฤษ `messages/en/trash.json` ทำไว้ด้วยเพราะ test ของ W21 บังคับให้ทุก namespace มีคู่ EN

**ช่องต่อเติมของ shell (สำหรับ W24 / W25 / W26)** · `src/components/shell/workspace-shell.tsx`
- `SHELL_SLOTS: ShellSlot[]` · `ShellSlot = { key; topbar?; banner?; overlay? }` แต่ละช่องเป็น component ที่ได้ `ShellSlotProps = { ws, workspace, me, pathname, openSearch }` (ใช้ hook ได้)
- `topbar` = ปุ่มบนแถบบนของ desktop ก่อนกระดิ่ง (หน้า Admin ไม่มี) · `banner` = บนสุดของเนื้อหาต่อจากแบนเนอร์แพ็กเกจ / ประกาศ · `overlay` = ของลอย render ท้าย shell ทุกหน้า · ทุกช่องไม่แสดงตอนถูกระงับแบบปิดทั้งหมด
- แต่ละงานแทนบรรทัดที่จองไว้ของตัวเอง 2 จุด (คอมเมนต์ `// W24 import` … ใต้ import และ `// W24 · …` ใน `SHELL_SLOTS`) ซึ่งเว้นบรรทัดว่างคั่นไว้ เพื่อให้ rebase ไม่ชนกัน · ไม่ต้องแก้ JSX ของ shell
- W24 merge เข้า main ก่อนงานนี้และวาง `WhatsNewButton` / `EngagementPrompts` ตรงใน JSX แล้ว ตอน rebase จึงเก็บไว้ตามเดิมและเอาบรรทัดจองของ W24 ออก · W25 ก็ merge ก่อนเช่นกัน (ปุ่มท้าย Sidebar และรายการในเมนูบัญชี ซึ่งไม่มีช่องให้) จึงคงไว้ใน JSX และเอาบรรทัดจองของ W25 ออก · ช่องที่เหลือใช้กับ W26

**คำขอนอก lane** (แก้แล้ว · ไฟล์เล็ก)
- `src/components/shell/workspace-shell.tsx` (W00 · งานนี้เป็นคิวแรก): ช่องต่อเติม · ส่วน "ลบไว้" ในตัวสลับ · Z5 แทนหน้าเมื่อ Workspace ถูกลบ
- `src/i18n/messages.ts`: ลงทะเบียน namespace `trash` (ใช้ใน shell) ทั้งไทยและ EN
- `src/test/server.ts`: handler ค่าเริ่มต้น `GET workspaces/deleted` (รายการว่าง) และ `GET workspaces/:slug/deleted` (404) ให้ test เดิมที่ render shell ไม่ยิงคำขอที่ไม่มี handler
- `src/lib/admin-automation.test.tsx` (W18): จำนวนลิงก์ในเมนู Admin Console 12 → 13
- `messages/en/trash.json` (W21)

**ตรวจแล้ว:** `src/features/trash/trash.test.tsx` 15 ข้อ (Z1 เมนู / แท็บ / แถว / ≤ 3 วันแดง · เลือกทั้งชุดแล้วกู้หลายงาน · ค้นหาและตัวกรองเป็น query · M1 ว่าง / Error requestId / 403 / สมาชิก · ลบถาวรพิมพ์ยืนยัน · Admin ไม่เห็นลบถาวร · ไฟล์ · Z2 Key ซ้ำ 2 รอบ · Z2 402 → Q2 · Z4 แท็บตามสิทธิ์ + การ์ด · Z4 ไม่มีสิทธิ์ · Z5 Owner ส่งออก + กู้คืน · Z5 สมาชิก · 404 · ตัวสลับ) · `pnpm --filter @friday/web typecheck` · `test` (33 ไฟล์ 575 ข้อ) · `build` ผ่าน · เปิดดูจริงที่ 1440 px กับ API ในเครื่อง (dev server + ฐานทดสอบ ไม่ใช่ Docker) ด้วยข้อมูลสมมติ: Z1 แท็บงาน / แถบชุด · Z2 Key ซ้ำแล้วกู้คืนด้วย MKT2 สำเร็จ · Z4 ใน Project Settings · Z5 Owner ส่งออกแล้วได้ปุ่มดาวน์โหลด · ตรงกับข้อเสนอ · ที่ 390 px ยังไม่ได้ดูในเบราว์เซอร์ (ปรับขนาดหน้าต่างไม่ได้ในรอบนี้ · มีแค่ CSS การ์ด ≤ 760 px และ test) จึงยังไม่ติ๊กข้อแรก · ยังไม่ได้ build / deploy Docker
