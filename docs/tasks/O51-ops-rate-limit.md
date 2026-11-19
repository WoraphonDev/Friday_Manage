# O51 · Friday Ops: Rate limit ต่อลูกค้า

| | |
|---|---|
| Wave | O-6 (เฟส 3) · ผู้ใช้อนุมัติ storyboard 20 พ.ย. 2569 |
| รอ merge | O50 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/core/{plan-limits,api-usage,core.module}.ts` + `auth/auth.guard.ts` (ส่งสถิติ) · `packages/db` (ตารางสถิติ) · `apps/ops-api/src/ratelimit/**` + กฎ `api_ratelimit` ใน `abuse` · `app/(console)/ratelimit/**` · `nav.ts` · messages |
| หน้าจอ | storyboard "Ops เฟส 3" › Story 2 (ขั้น 1–2) |
| สเปก | [06-ops-roles](../spec/06-ops-roles.md) |

อ่าน [README](README.md) ก่อนเริ่ม

## ทำอะไร

- **สถิติ:** API นับคำขอ / ถูกปฏิเสธ (429) ต่อ Workspace + token + endpoint ต่อนาที แล้วเขียนเป็นชุดทุก 10 วินาที (ไม่เขียนทุกคำขอ) · เก็บรายนาที 7 วัน แล้วยุบเป็นรายชั่วโมงเก็บ 90 วัน
- **ต้องทำตอนนี้:** ลูกค้าที่ชนเพดานติดกันเกิน 15 นาที (แจ้ง Owner ของลูกค้า / ดู)
- **ตาราง:** แท็บ ชนเพดาน 24 ชม. · ใกล้เพดาน (>80%) · ปรับเฉพาะราย · ค้น Workspace / token · ตัวกรอง แพ็กเกจ · มีการปรับ · ชนกี่นาทีขึ้นไป · token
- **แผงขวา:** กราฟรายนาที 24 ชม. + เส้นเพดาน · แยกตาม token และ endpoint · ปรับเพดานชั่วคราว (เขียนลง `entitlement_overrides` key `api_rpm` เดิม มีเหตุผลและวันหมด · เกิน 3 เท่าของแพ็กเกจขออนุมัติ Owner) · ระงับ token (รายชื่อที่ถูกบล็อกของ O50 + revoke) · แจ้ง Owner
- เปิดกฎ `api_ratelimit` ของ O50 (ชนเพดานเกิน 15 นาทีติดกัน +30)
- หลายเครื่อง: ยังนับในหน่วยความจำของ API ตัวเดียว · ย้ายไป Valkey ใน I01

## เสร็จเมื่อ

- [ ] หน้าตรงกับ storyboard ที่ 1440 px · ใช้งานได้ที่ 390 px
- [ ] e2e ของ API ที่แก้ + component test ของหน้า
- [ ] `pnpm typecheck` และ test ของแพ็กเกจที่แก้ผ่าน
- [ ] deploy Docker ในเครื่องตาม CLAUDE.md และตรวจผ่าน :4000 / :3000

## บันทึกผล

**ทำแล้ว**
- API ลูกค้า `core/api-usage.ts`: `PlanLimits.rateLimit` บันทึกทุกคำขอผ่าน API token (token + route ของ Nest + เพดานตอนนั้น) รวมในหน่วยความจำ เขียนเป็นชุดทุก 10 วินาที · งาน `api.usage-rollup` ทุกชั่วโมงยุบเป็นรายชั่วโมง (รันซ้ำได้) ลบรายนาทีเกิน 7 วัน / รายชั่วโมงเกิน 90 วัน
- ตาราง `api_usage_minutes` / `api_usage_hours` (migration 0056 · ปิด friday_app)
- ops-api `src/ratelimit/`: ตัวเลขหัวหน้า · ต้องทำตอนนี้ = ชนเพดานต่อเนื่อง ≥ 15 นาทีที่ยังไม่จบ (gaps and islands) · แท็บ ชนเพดาน / ใกล้เพดาน (>80% ไม่ถูกปฏิเสธ) / ปรับเฉพาะราย · ค้น Workspace หรือชื่อ token · ตัวกรองแพ็กเกจ / มีการปรับ / ชนกี่นาที · แผงขวา กราฟรายนาที 24 ชม. + แยกตาม token / endpoint · แจ้ง Owner (อีเมล + Audit log ลูกค้า · ซ้ำภายใน 1 ชม. ไม่ได้) · ปรับเพดานชั่วคราว 1–30 วันผ่าน `EntitlementsService.createOverride` เดิม (headroom 3 เท่า · เกินตอบ 202 ขออนุมัติ)
- ระงับ token จากแผงขวา = เพิ่ม api_token ในรายชื่อที่ถูกบล็อกของ O50 (ยกเลิก token ทันที)
- เปิดกฎ `api_ratelimit` ของ O50 (ชนเพดานต่อเนื่อง ≥ 15 นาทีที่จบภายใน 1 ชม. +30) · ตัวนับ `rateLimitStreak` ในเมนู ภาพรวม และแผงแจ้งเตือน

**ตัดสินเอง / ต่างจาก storyboard**
- เก็บเพดาน ณ นาทีนั้น (`limit_rpm`) ในสถิติ แทนการคำนวณย้อนหลัง จึงวาดเส้นเพดานตรงตามที่ใช้จริงแม้มีการปรับกลางวัน
- นับเฉพาะคำขอผ่าน API token (ทางเดียวที่มีเพดาน) ไม่นับการใช้งานผ่านหน้าเว็บ
- "ใกล้เพดาน" ไม่รวมรายที่ถูกปฏิเสธแล้ว ให้แท็บไม่ซ้ำกัน
- ยังนับในหน่วยความจำของ API ตัวเดียว (หลายเครื่องรอ I01 · ระบุในหน้าแล้ว)

**คำขอนอก lane**: `docs/spec/01-entities.md` (api_usage_minute, api_usage_hour) · `packages/db/test` (ตารางใหม่) · `apps/ops-api/src/entitlements` (พารามิเตอร์ headroom + export service)
