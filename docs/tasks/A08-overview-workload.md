# A08 · Overview โปรเจกต์ และ Workload

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/overview/**` · `apps/api/test/overview.e2e.test.ts` |
| หน้าจอ | 1 (`design/canvas/Main.dc.html`) · 7 (`design/canvas/Members.dc.html`) · M6 (`design/canvas/MobileOverview.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 2 หน้า 1 และ 7 · 03-api › 3.2 แถว `w/workload` · docs/decisions.md (Man-Day แบ่งเท่ากันต่อ Dev ตอนคิด Workload) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET p/overview`: ความคืบหน้า (ตาม `progress_method`), Health (on track / at risk / off track), KPI (งานทั้งหมด / เสร็จ / เลยกำหนด / MD), Milestone, Workload สัปดาห์นี้ต่อคน, Burn-up รายสัปดาห์ (แผน vs เสร็จ), Activity ล่าสุด 10 รายการ
- กติกา Health: เทียบ % MD ที่ควรเสร็จตามแผน ณ วันนี้ กับ % ที่เสร็จจริง · ต่างไม่เกิน 5% = on track · ไม่เกิน 15% = at risk · เกิน = off track · เขียนไว้ในคอมเมนต์และ "บันทึกผล" เพราะผู้ใช้ยังไม่ได้ยืนยัน
- `GET p/workload?from&to&unit=md|hour&group=week` ต่อคนต่อสัปดาห์: MD ที่ได้รับ (Man-Day ÷ จำนวน Dev กระจายตามวันทำการของงาน), capacity (`project_members` → `workspace_members`), หักวันลา (`leaves`), เกิน capacity
- `GET w/workload?from&to&team=` รวมทุกโปรเจกต์ (`ws.workload.view`)
- แยกการคำนวณไว้ใน `overview/workload.ts` (export) ให้ A09, A10 ใช้

## กติกาที่ต้องตรง

- Guest ที่เป็น Viewer: overview ตัดชื่อคนและ Bug ออก · workload → 403

## เสร็จเมื่อ

- [ ] test: Workload ของงาน 2 Dev แบ่งครึ่ง, วันลาลด capacity, Health 3 ระดับ
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- Lead Dashboard (A09)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
