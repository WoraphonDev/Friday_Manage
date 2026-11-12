# A43 · API: Onboarding checklist ของลูกค้า

| | |
|---|---|
| Wave | O-4 · **รอผู้ใช้อนุมัติหน้าจอใน `design/proposals/phase3`** |
| รอ merge | O32 · A34 (ใช้ `onboarding.step_done`) |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/onboarding/**` (module ใหม่) · `apps/api/test/onboarding.e2e.test.ts` |
| หน้าจอ | `design/proposals/phase3/02-onboarding-checklist.html` › V1–V4 |
| สเปก | [05-business-metrics](../spec/05-business-metrics.md) › 1.2 (`onboarding.step_done`) · 2 (นิยาม "เริ่มใช้จริง") |

อ่าน [README](README.md) ก่อนเริ่ม · หน้าจอเป็น**ข้อเสนอ** เริ่มได้เมื่อผู้ใช้อนุมัติไฟล์ 02 แล้ว

## ทำอะไร

- ขั้นของ Workspace (Owner / Admin เห็น) ตรวจจากข้อมูลจริง ไม่ใช่การกดติ๊ก:
  1. โปรเจกต์ที่ไม่ใช่ตัวอย่าง ≥ 1 · 2. งาน (ไม่นับที่ลบ) ≥ 10 · 3. สมาชิกที่ตอบรับ ≥ 3 รวมเจ้าของ ไม่นับ Guest · 4. งานที่มีผู้รับผิดชอบและ Due ≥ 5 · 5. เปลี่ยนสถานะงาน ≥ 1 · 6. มีสมาชิกผูก LINE หรือเปิดอีเมลแจ้งเตือน ≥ 1
- ขั้นส่วนตัวของสมาชิก (V3): ตั้งรูปและเวลาทำงาน · เปิดงานแรกที่ได้รับมอบหมาย · เลือกช่องทางแจ้งเตือน
- `GET w/onboarding` คืนขั้น สถานะ ตัวเลขประกอบ (เช่น 1 / 2 คน) ขั้นถัดไป และลิงก์ปุ่ม · `POST w/onboarding:hide` / `:show` / `:never` ต่อคน
- ฟัง `issue.created`, `member.joined` ฯลฯ ผ่าน `EventBus.on` ใน `onModuleInit` · เมื่อขั้นเสร็จครั้งแรกบันทึก `onboarding_progress` แล้ว `EventBus.publish('onboarding.step_done')` (ให้ A34 เขียน `product_events`)
- Workspace ที่สร้างก่อนเปิดฟีเจอร์และ "เริ่มใช้จริง" แล้วไม่แสดงการ์ด
- เหตุการณ์ต่อท้าย `EventType`: `onboarding.step_done` (ถ้ายังไม่มี) · `onboarding.completed`

## เสร็จเมื่อ

- [ ] e2e test ด้วยข้อมูลสมมติครอบคลุมทุกขั้น · ซ่อน / แสดง · สมาชิก vs Owner / Admin · Guest ไม่เห็น · Workspace เก่าไม่เห็น
- [ ] ทุก query ผ่าน `TenantDb.run` · `pnpm typecheck` / `pnpm --filter @friday/api test` ผ่าน
- [ ] build และ deploy Docker API (`compose.api.yml`) ด้วยฐานข้อมูลเดิม แล้วเรียก endpoint จริงผ่าน :3001

## ยังต้องตัดสินใจ

- **6 ขั้นที่เสนอ** (ขั้น 2–3 ตามนิยาม "เริ่มใช้จริง" และขั้น 6 เพราะลูกค้าที่ผูก LINE ยกเลิกน้อยกว่า 2.4 เท่าในหน้า "ธุรกิจและกำไร") · **แนะนำ:** ใช้ 6 ขั้นนี้ แล้วทบทวนเมื่อมีข้อมูล 3 เดือน
- **รายการส่วนตัวของสมาชิก (V3)** · **แนะนำ:** ทำพร้อมกัน เพราะใช้กลไกเดียวกันและช่วยให้สมาชิกใหม่ตั้งเวลาทำงาน (Workload ถูกต้อง) · ตัดออกได้ถ้าต้องการลดงาน

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน -->
