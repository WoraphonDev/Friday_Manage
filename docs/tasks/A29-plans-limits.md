# A29 · แพ็กเกจ, ขีดจำกัด (402) และใบเสนอราคา

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/billing/**` · `apps/api/test/plans.e2e.test.ts` · `apps/api/src/core/plan-limits.ts` |
| หน้าจอ | Q2 (`design/canvas/PlanLimits.dc.html`) · R2 (`design/canvas/Checkout.dc.html`) · N1 (`design/canvas/AdminConsole.dc.html`) |
| สเปก | 03-api › 3.10 · 03-api › 1 Error (402) · memory ของโปรเจกต์: Free ≤ 5, Team S ≤ 10, M ≤ 25, L ≤ 50, Enterprise · ทุกแพ็กเกจ Team ฟีเจอร์เท่ากัน |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `PlanLimits.assert` จริง: projects, seats (ไม่นับ Guest), storage_bytes → 402 `plan_limit_reached` พร้อม `details` (ขีดจำกัด, ค่าปัจจุบัน, ทางออก)
- Workspace ใหม่ทดลอง Team 14 วัน (`subscription`)
- `GET w/usage` · `GET w/billing` · `GET w/billing/quote?plan&cycle&wht` (VAT 7%, หัก ณ ที่จ่าย 3%) · `GET / PUT w/billing/profile`

## กติกาที่ต้องตรง

- เงินเป็นสตางค์

## เสร็จเมื่อ

- [x] test: เกินแต่ละประเภทได้ 402 ตามหน้า Q2, quote ถูกต้องทุกกรณี
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ชำระเงินจริง (A33)

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/billing/`)

| Method | Path | สิทธิ์ |
|---|---|---|
| GET | `w/:ws/usage` | สมาชิก (Guest 403) · ตอบ plan, trial (`daysLeft`, `expired`), `seats` / `projects` / `storage` แบบ `{ used, limit, ratio, over }` และ `canManageBilling` ให้หน้าเลือกปุ่ม "เปลี่ยนแพ็กเกจ" / "ขอให้ Admin อัปเกรด" |
| GET | `w/:ws/billing` | Owner / Admin (`ws.billing`) · แพ็กเกจ, ขีดจำกัด, ใบแจ้งหนี้ 24 รายการล่าสุด, ข้อมูลภาษี |
| GET | `w/:ws/billing/quote?plan=team_s\|team_m\|team_l&cycle=monthly\|yearly&wht=` | `ws.billing` · เงินเป็นสตางค์ |
| GET / PUT | `w/:ws/billing/profile` | `ws.billing` · PUT เป็น upsert (1 Workspace = 1 profile) + Audit `billing.profile_updated` |

`PlanLimits.assert(tx, workspaceId, 'projects' | 'seats' | 'storage_bytes', increment)` ตรวจจริงแล้ว → 402 `plan_limit_reached` พร้อม `details: { kind, limit, current, increment, plan, suggestedPlan, exits }` (`exits` เช่น `['archive_project', 'upgrade']`) · เพิ่ม `PlanLimits.snapshot` ให้งานอื่นอ่านแพ็กเกจและการใช้งานได้

### คำตัดสินที่เลือกเอง

- **ขีดจำกัด** ตาม `docs/decisions.md` + หน้า Q2 / Landing: Free = 5 คน · 3 โปรเจกต์ · ไฟล์ 1 GB ต่อคน; Team S / M / L = 10 / 25 / 50 คน · โปรเจกต์ไม่จำกัด · ไฟล์ 10 GB ต่อคน; Enterprise ไม่จำกัด · ค่าอยู่ใน `billing/catalog.ts` (ค่าใน `plans.seat_limit` / `storage_gb_per_member` ที่ไม่ใช่ null ชนะค่าในโค้ด)
- **ราคา**: ยังไม่ตกลงจริง (`plans.price_*` เป็น null) จึงใช้ตัวเลขจากหน้า Checkout เป็นค่าตั้งต้น: S 1,500 · M 3,000 · L 5,500 บาท/เดือน · รายปี = 10 เดือน · ถ้าตั้ง `plans.price_*` จะใช้ค่านั้นแทน **ต้องให้ผู้ใช้ยืนยันราคาจริงก่อนเปิดขาย**
- **สูตร quote**: VAT 7% คิดจากยอดก่อนภาษี · หัก ณ ที่จ่าย 3% คิดจากยอดก่อน VAT (ตรงหน้า R2) · ปัดเศษด้วย `Math.round` · `amountDue = total − whtAmount` · quote ไม่ตรวจวิธีชำระ (ว่า wht ใช้กับบัตรไม่ได้) เป็นหน้าที่ของ checkout (A33)
- **ทดลอง 14 วัน**: สร้าง `subscription` (Team S, `trialing`) แบบ lazy ตอนเรียกครั้งแรกด้วย `ensureSubscription` นับจาก `workspaces.created_at` · ทดลองหมดหรือยกเลิกจนครบรอบ → ใช้สิทธิ์ของ Free โดยไม่แก้แถวในฐานข้อมูล · แถวใน `plans` ที่ขาด (เช่นฐานที่ถูกล้างตอน test) จะถูกเติมให้ด้วย `SYSTEM_DB` เพราะ `friday_app` อ่าน `plans` ได้อย่างเดียว
- **นับ**: Seat = สมาชิก `active` ที่ไม่ใช่ Guest · โปรเจกต์ = ไม่ถูกลบและไม่ถูก Archive · พื้นที่ = ผลรวม `file_versions.size_bytes` รวมไฟล์ในถังขยะ (หน้า Q2: ลบจากถังขยะจึงคืนพื้นที่) · พื้นที่รวมของทีม = GB ต่อคน × จำนวน Seat (อย่างน้อย 1 คน)

### คำขอนอก lane

- **A14** (`workspaces/**`, `invitations/**`): (1) `POST workspaces` ควรสร้าง subscription ทดลองเองตอนสร้าง Workspace (ตอนนี้ทำแบบ lazy จึงไม่กระทบ) (2) `POST w/invitations` ควรเรียก `limits.assert(tx, ws, 'seats', จำนวนคนที่เชิญ)` ตอนสร้างคำเชิญตาม 03-api 3.3 — ตอนนี้ตรวจแค่ตอนตอบรับ (`invitations.service.ts:183`)
- **A11** (`files/**`): เรียก `PlanLimits.assert(tx, ws, 'storage_bytes', sizeBytes)` ก่อนออก upload URL
- **T00**: ถ้าจะให้ราคา / พื้นที่ของแต่ละแพ็กเกจอยู่ใน seed ให้ตั้ง `plans.price_*` และ `storage_gb_per_member` (ตอนนี้ null)

### ไม่ได้ทำ (ไม่อยู่ใน "ทำอะไร" ของงานนี้)

- ช่วงผ่อนผัน 14 วันเมื่อทีมโตเกินแพ็กเกจ, สถานะอ่านอย่างเดียวเมื่อค้างชำระ, การเลือก "3 โปรเจกต์ที่ใช้ต่อ" หลังทดลองหมด, โควตา Automation 1,000 ครั้ง/เดือน, การล็อก tab ตามฟีเจอร์ (Gantt บน Free) และการแจ้ง Inbox เมื่อ Member กด "ขอให้ Admin อัปเกรด" — ต้องมี schema หรือ endpoint เพิ่ม ยังไม่มีงานรองรับ · ตอนนี้ตรวจแค่ Seat / โปรเจกต์ / พื้นที่ ตามที่ระบุ
- ชำระเงินจริง (A33): ตัวเปลี่ยนแพ็กเกจต้องอัปเดต `subscriptions` แล้ว `PlanLimits` จะอ่านค่าใหม่เองทุกครั้ง (ไม่มี cache)

### ผล test

`apps/api/test/plans.e2e.test.ts` 18 กรณี: 402 ของโปรเจกต์ / Seat (ตอบรับคำเชิญ, Guest ไม่นับ, แนะนำแพ็กเกจ) / พื้นที่ไฟล์ (ขอบเขตพอดี 100 / 101 ไบต์), Archive แล้วสร้างได้, ทดลองหมด → Free, Enterprise ไม่จำกัด, quote ทุกแบบ (รายเดือน / รายปี / wht / ปัดเศษ / แพ็กเกจที่ซื้อไม่ได้), profile และสิทธิ์ · `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (db 107, api 232)
