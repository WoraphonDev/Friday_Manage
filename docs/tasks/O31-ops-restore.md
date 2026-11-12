# O31 · Friday Ops: กู้คืนข้อมูลที่ลูกค้าลบผิด และ Workspace ที่รอลบถาวร

| | |
|---|---|
| Wave | O-3 (เฟส 1) · อนุมัติหน้าจอแล้ว 12 พ.ย. 2569 |
| รอ merge | O30 · A41 (ใช้ตรรกะกู้คืนชุดเดียวกัน) |
| Lane (แก้ได้เฉพาะ) | `apps/ops-api/src/restore/**` · `apps/ops-api/test/restore.e2e.test.ts` · `apps/ops-web/app/(console)/restore/**` |
| หน้าจอ | `design/proposals/phase3/05-restore-data.html` › บอร์ด 21 · Z6 กู้คืนให้ลูกค้า · Z7 ยืดเวลา · Z8 กู้ Workspace แทนลูกค้า · Z9 เกินระยะ |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) · [decisions](../decisions.md) › SaaS (เข้าบัญชีลูกค้าต้องมี Ticket) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอใน `design/proposals/phase3` ผู้ใช้อนุมัติแล้ว (12 พ.ย. 2569) ยึดตามไฟล์นั้น

## ทำอะไร

- หน้า "กู้คืนข้อมูลลูกค้า": เลือก Workspace + Ticket (บังคับ) → รายการในถังขยะแบบสรุป (เลข ชื่อโปรเจกต์ จำนวน ผู้ลบ วันลบถาวร · ไม่แสดงชื่องาน) · จัดชุดงานที่ลบพร้อมกัน
- กู้คืนให้ลูกค้า (Z6): ตรวจว่าผู้แจ้งใน Ticket เป็น Owner / Admin ของ Workspace · เหตุผลลงทั้ง `audit_logs` ของลูกค้า (ป้าย "ทีม Friday") และ `staff_audit_logs` · อีเมลแจ้ง Owner / Admin · ตอบ Ticket ให้อัตโนมัติ · ไม่ต้องขออนุมัติคนที่สอง
- Workspace ที่รอลบถาวร: ยืดเวลา (Z7) รวม ≤ 30 วันทำเองได้ เกินนั้นใช้ `@Approval` (G7) · กู้ Workspace แทนลูกค้า (Z8) ต้องแตะกุญแจ (G4) และอนุมัติทุกครั้งเหมือนโอนความเป็นเจ้าของ · ช่วงมี Owner คนเดียวใช้ G12
- ค้นด้วยเลขงาน / Key แล้วพบว่าลบถาวรแล้ว แสดง Z9 จาก Audit log
- สิทธิ์: Support กู้งาน / โปรเจกต์ / ไฟล์ และยืดเวลา · Owner อนุมัติ · วิศวกรและผู้ตรวจอ่านอย่างเดียว · การเงินไม่เห็นเมนู
- ops-api ปัจจุบันตอบ 409 `workspace_deleted` กับ Workspace ที่ลบแล้ว · module นี้อ่านแถวเหล่านั้นได้โดยเฉพาะ
- **คำขอนอก lane:** ลงทะเบียน module ใน `apps/ops-api/src/app.module.ts` (O01) · เปลี่ยนเมนู "กู้คืนข้อมูลลูกค้า" ใน `apps/ops-web/src/components/shell` จาก "เร็ว ๆ นี้" เป็นลิงก์ (O10)

## เสร็จเมื่อ

- [ ] หน้าตรงกับข้อเสนอที่อนุมัติแล้วที่ 1440 px · ที่ 390 px ใช้งานได้
- [x] ครบทุกสถานะตาม M1 · ซ่อนปุ่มตามบทบาท · Audit ทุกการกระทำ
- [x] e2e test ของ ops-api (ข้อมูลสมมติ) + component test ด้วย MSW · typecheck / test / build ผ่าน
- [ ] build และ deploy Docker ชุด ops (`compose.ops.yml`) ในเครื่องตาม CLAUDE.md แล้วกู้คืนจริงผ่าน http://localhost:4000 และเห็นผลในเว็บลูกค้า :3000

## ยังต้องตัดสินใจ

**ผู้ใช้ตัดสินแล้ว (12 พ.ย. 2569): ใช้ตามคำแนะนำทุกข้อ** · ข้อความ "แนะนำ" ด้านล่างคือคำตัดสิน

- **กู้คืนต้องอนุมัติคนที่สองหรือไม่** · **แนะนำ:** ไม่ต้องสำหรับงาน / โปรเจกต์ / ไฟล์ เพราะไม่ทับข้อมูลและลูกค้าลบซ้ำได้ · Workspace ต้องอนุมัติทุกครั้ง
- **ใช้หน้านี้แทนการเข้าบัญชีโหมดแก้ไข** (Canvas Q3 เคยแสดงการกู้โปรเจกต์ผ่านโหมดแก้ไข ซึ่งยังไม่เปิดจนมีผู้อนุมัติคนที่สอง) · **แนะนำ:** ใช้หน้านี้
- **วงเงินยืดเวลา** ≤ 30 วันรวมโดยไม่ต้องอนุมัติ · **แนะนำ:** ตามนี้ และเพิ่มเป็นเรื่องในตารางวงเงินของ 06-ops-roles (D99)
- **กู้จากสำรองข้อมูลหลังพ้นถังขยะ** ไม่อยู่ในงานนี้ · **แนะนำ:** เขียนเป็น runbook ใน I01 แทนหน้าจอ แล้วค่อยทำปุ่มในเฟส 3

## บันทึกผล

ส่งงาน 12 พ.ย. 2569 · ops-api module `restore` · หน้า `/restore` ใน ops-web · ไม่มี migration

**ops-api (`ops/restore/*`)** · ใช้บัญชี friday_worker จึงกรอง workspace_id เองทุกคำสั่ง · อ่าน Workspace ที่ลบแล้วได้เฉพาะ module นี้
- `GET summary` การ์ดสรุป (Workspace รอลบ / ใกล้ 7 วัน · กู้คืน 30 วันแยกชนิด · ลบถาวรคืนนี้ = พ้น trash_days ภายใน 24 ชม. · สำรอง 35 วัน)
- `GET tickets?workspaceId` Ticket ที่ยังไม่ปิด พร้อมบอกว่าผู้แจ้งเป็น Owner / Admin หรือไม่ (ตรวจ requester_user_id หรืออีเมลผู้แจ้งกับสมาชิก active)
- `GET trash?workspaceId&ticketId` ต้องมี Ticket ของ Workspace นั้น (ไม่ตรงตอบ 422) · รายการสรุปไม่มีชื่องาน / ชื่อไฟล์: โปรเจกต์ (Key ชื่อ จำนวนงาน / ไฟล์ Key ซ้ำ) · งานรวมเป็นชุดเมื่อคนเดียวกันลบใน 2 นาที (เลขงาน Sub-task) · ไฟล์รวมแบบเดียวกัน (จำนวน ขนาด โฟลเดอร์)
- `POST ops/restore` `{ workspaceId, ticketId, type, ids, newKey?, reason, notify, replyTicket }` (Support / Owner · ไม่ต้องอนุมัติ) · Ticket ต้องมาจาก Owner / Admin (403 `requester_not_admin`) · ตรรกะเดียวกับ A41: งานกลับพร้อม Sub-task ที่ลบพร้อมกัน (cascadeRootId) · แม่ต้องไม่อยู่ในถังขยะ · Key ซ้ำตอบ 409 `project_key_taken` + Key ที่แนะนำ แล้วเก็บ Key เดิมเป็น alias · ไฟล์ที่โฟลเดอร์หายกลับไปที่ราก · Workspace ที่ลบอยู่ตอบ 409 ให้ใช้กู้ Workspace แทน · Audit `restore.<type>` ทั้ง audit_logs ของลูกค้า (friday_staff) และ staff_audit_logs · activities ของงานเป็น `restored` โดย friday_staff · อีเมล Owner / Admin · ตอบ Ticket ผ่าน `TicketsService.message` (ลูกค้าได้อีเมลด้วย)
- `GET lookup?workspaceId&q` (Z9) ยังอยู่ / ในถังขยะ / ลบถาวรแล้ว (หา `issue.deleted` / `project.deleted` และ `trash.purged` ใน audit_logs ของลูกค้า) / ไม่พบ
- `GET workspaces` Workspace ที่รอลบถาวร (แพ็กเกจเดิม ผู้ลบ วันลบถาวร ยืดแล้วกี่วัน Ticket ที่เปิดอยู่ คำขออนุมัติที่รอ)
- `POST workspaces/:id/extend` (Z7) `{ days, ticketId, reason, notify }` · รวม ≤ 30 วันทำได้เลย · เกินตอบ 202 คำขอ `restore.extend_purge` (G7) · อีเมล Owner วันใหม่ · Audit `restore.extended`
- `POST workspaces/:id/restore` (Z8) `@Reauth` (G4) + คำขอ `restore.workspace` ทุกครั้ง (202 · G12 ตาม ApprovalsService) · ห้ามมีคำขอซ้ำ · อนุมัติแล้วล้าง deleted_at (trigger ล้าง deleted_by / purge_after) · อีเมล Owner · ตอบ Ticket
- `GET history` จาก staff_audit_logs action `restore.*`
- สิทธิ์: อ่าน = Owner / Support / วิศวกร / ผู้ตรวจ · กู้คืน / ยืดเวลา / ขอกู้ Workspace = Owner / Support · การเงิน 403

**ops-web** หน้า `/restore` (บอร์ด 21): การ์ดสรุป 4 ใบ · แท็บ ค้นข้อมูลที่ลบ / Workspace ที่รอลบถาวร / ประวัติ · ค้นด้วย Workspace + Ticket (บังคับ) แล้วแสดงตารางสรุปพร้อมชิปกรองชนิด · เหลือ ≤ 3 วันสีแดง · Ticket จากสมาชิกธรรมดาแสดงเหตุผลและปิดปุ่ม · ค้นเลขงาน / Key (Z9 พร้อมปุ่มเฟส 3 ที่ปิดไว้) · Drawer Z6 (Key ใหม่เมื่อซ้ำ ใช้ Key ที่ ops-api แนะนำ) · Modal Z7 (7 / 14 / 30 วัน · เกินวงเงินเปลี่ยนเป็นส่งขออนุมัติ) · Modal Z8 (แตะกุญแจผ่าน useReauth + useApprovalFlow) · วิศวกร / ผู้ตรวจเห็นแถบอ่านอย่างเดียวและไม่มีปุ่ม · การเงินเห็นหน้าไม่มีสิทธิ์ · Error แสดง requestId

**ต่างจากหน้าจอที่เสนอ**
- Z6 "ที่อยู่หลังกู้คืน" เป็นข้อความทั่วไป (ที่เดิมใน Module / กลุ่มงาน / Sprint) ไม่คำนวณ Sprint ที่ปิดแล้วรายงาน เพราะการกู้คืนไม่ย้ายงาน
- Z6 "จะกู้คืน" ไม่นับไฟล์แนบ / คอมเมนต์เป็นตัวเลข (ไม่ได้ลบไปพร้อมงานอยู่แล้ว)
- ปุ่ม "กู้คืน" ใน Workspace ที่รอลบถาวรแสดงเมื่อมี Ticket ที่เปิดอยู่ · ยืดเวลาต้องมี Ticket เช่นกัน (ปุ่มปิดถ้าไม่มี)
- เพิ่มช่อง "ค้นด้วยเลขงาน / Key" ในผลค้นหาเพื่อเข้าสถานะ Z9 (บอร์ดไม่ได้วางตำแหน่งไว้)
- ตารางที่ 390 px เลื่อนแนวนอนได้ (ใช้ tbl-wrap แบบหน้าอื่นของ Ops) ไม่ได้ทำเป็นการ์ด

**ตัดสินใจระหว่างทำ**
- ทีม Friday กู้โปรเจกต์ได้โดยไม่ตรวจขีดจำกัดแพ็กเกจ (ลูกค้าเห็นแถบเกินแพ็กเกจตามกติกา Q2) · ฝั่งลูกค้ายังตอบ 402 ตาม A41
- ชื่อไฟล์ไม่ส่งออกจาก ops-api เลย (รายการและข้อความตอบ Ticket ใช้ "โปรเจกต์ · ไฟล์") เพื่อให้ทีม Friday ไม่เห็นเนื้อหา
- อีเมลเตือนก่อนลบถาวรหลังยืดเวลาใช้กลไกของ A41 (`purge_reminded_at`) รอบเตือนเลื่อนตามวันใหม่เอง

**คำขอนอก lane (ทำแล้ว):** ลงทะเบียน `RestoreModule` ใน `apps/ops-api/src/app.module.ts` · เมนู `restore` ใน `apps/ops-web/src/components/shell/nav.ts` เป็นลิงก์ `/restore` (Owner / Support / วิศวกร / ผู้ตรวจ) · namespace `rst` ใน `apps/ops-web/src/i18n/messages.ts` + `messages/th/restore.json` · ชื่อคำขออนุมัติ 2 ชนิดใน `messages/th/common.json › kinds` · ให้ D99 เพิ่มเรื่อง "ยืดเวลาก่อนลบถาวร ≤ 30 วัน" ในตารางวงเงินของ 06-ops-roles

**ตรวจแล้ว:** `apps/ops-api/test/restore.e2e.test.ts` 10 ข้อ · `app/(console)/restore/restore.test.tsx` 8 ข้อ · ops-web 23 ไฟล์ 162 ข้อ · typecheck / build ของ ops-api และ ops-web ผ่าน · ยังไม่ได้เทียบภาพในเบราว์เซอร์ (หน้า Ops ต้องล็อกอินด้วย Security key) และยังไม่ได้ build / deploy Docker ชุด ops
