# W23 · เว็บ: ถังขยะ กู้คืนโปรเจกต์ และหน้า Workspace ที่ลบไว้

| | |
|---|---|
| Wave | O-3 (เฟส 1) · **รอผู้ใช้อนุมัติหน้าจอใน `design/proposals/phase3`** |
| รอ merge | A41 |
| Lane (แก้ได้เฉพาะ) | `apps/web/src/features/trash/**` · `apps/web/messages/th/trash.json` · `apps/web/app/work/[ws]/admin/_components/admin-console.tsx` (เพิ่มเมนูถังขยะเท่านั้น) · `apps/web/app/work/[ws]/p/[key]/settings/_components/project-settings.tsx` (เพิ่มแท็บถังขยะเท่านั้น) |
| หน้าจอ | `design/proposals/phase3/05-restore-data.html` › Z1 ถังขยะ · Z2 กู้คืนโปรเจกต์ · Z3 ลบถาวร · Z4 ถังขยะของโปรเจกต์ · Z5 Workspace ที่ลบไว้ |
| สเปก | [03-api](../spec/03-api.md) › 3.8 · [04-permissions](../spec/04-permissions.md) |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอเป็น**ข้อเสนอ** เริ่มได้เมื่อผู้ใช้อนุมัติไฟล์ 05 แล้ว

## ทำอะไร

- Admin Console › ถังขยะ (Z1): แท็บโปรเจกต์ / งาน / ไฟล์ · ค้นหา · กรองโปรเจกต์และผู้ลบ · เลือกหลายแถว · "เลือกทั้งชุด" · กู้คืน · ลบถาวร (Owner) · เหลือ ≤ 3 วันเป็นสีแดง
- Project Settings › ถังขยะ (Z4) สำหรับสิทธิ์ `project.trash` · ตารางเดียวกันที่กรองโปรเจกต์ไว้ · มือถือเป็นการ์ด
- Dialog กู้คืนโปรเจกต์ (Z2) พร้อมกรณี Key ซ้ำ และเกินแพ็กเกจ (ใช้ PlanLimitDialog เดิม) · ลบถาวร (Z3 ระดับ 3 ของ P3)
- หน้า Workspace ที่ลบไว้ (Z5): Owner กู้คืนและส่งออกข้อมูล · สมาชิกเห็นข้อความให้ติดต่อ Owner · ตัวสลับ Workspace มีส่วน "ลบไว้ · กู้คืนได้" จาก `GET workspaces/deleted` ที่มีอยู่
- ข้อความทั้งหมดใน namespace `trash` · ภาษาอังกฤษให้ W21
- **คำขอนอก lane:** `src/components/shell/workspace-shell.tsx` (ไฟล์กลางของ W00) เพิ่มส่วน "ลบไว้" ในตัวสลับ และแสดง Z5 แทนเนื้อหาเมื่อ Workspace อยู่ในสถานะลบ · งานนี้เป็นงานแรกในชุดที่แตะไฟล์นี้ ให้เพิ่มเป็นช่อง (slot) สั้น ๆ เพื่อให้ W24–W26 ต่อได้โดยไม่ชนกัน

## เสร็จเมื่อ

- [ ] หน้าตรงกับข้อเสนอที่อนุมัติแล้วที่ 1440 px · ที่ 390 px ใช้งานได้
- [ ] ครบทุกสถานะตาม M1 (กำลังโหลด · ถังขยะว่าง · Error พร้อม requestId · ไม่มีสิทธิ์) · ซ่อนปุ่มตาม `my-permissions`
- [ ] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] build และ deploy Docker เว็บ (และ API ของ A41) ในเครื่องตาม CLAUDE.md แล้วลบ / กู้คืนจริงผ่าน http://localhost:3000

## ยังต้องตัดสินใจ

- **ทำก่อนเปิดตัวหรือไม่** · **แนะนำ:** ทำก่อนเปิดตัว (เฟส 1 ตาม ComingSoon) เพราะตอนนี้ข้อความหลังลบโปรเจกต์บอกลูกค้าว่า "กู้คืนได้ภายใน N วัน" แต่ไม่มีทางกู้
- **ที่วางถังขยะ** ทั้ง Admin Console (ระดับ Workspace) และ Project Settings (ระดับโปรเจกต์) · **แนะนำ:** ทั้งสองที่ เพราะโปรเจกต์ที่ลบเปิดไม่ได้แล้ว และ Project Admin ไม่ได้เป็น Admin ของ Workspace เสมอ

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
