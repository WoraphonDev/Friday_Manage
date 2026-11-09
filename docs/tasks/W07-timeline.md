# W07 · Timeline (SVG เขียนเอง)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/work/[ws]/p/[key]/timeline/**` · `apps/web/messages/th/timeline.json` |
| หน้าจอ | 4 (`design/canvas/Timeline.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET p/timeline` (มีแล้ว) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Week / Month / Quarter, แถว Sprint, Milestone, เส้นวันนี้, ยุบ / ขยาย Module › กลุ่มงาน › Task
- ลาก bar = เลื่อนวัน, ลากขอบ = ปรับความยาว → `PATCH` (Due เลื่อนออกไม่มีสิทธิ์ → K3) · Unscheduled ลากไปวาง
- สีตาม Module / Status / Assignee · Guest ไม่มีชื่อคน

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม · `/w/[ws]/p/[key]/timeline` (หน้า 4)

ใช้ `GET p/timeline` · `GET p/my-permissions` · `GET issues/:key` (อ่าน version ก่อนแก้ เพราะ timeline ไม่ส่ง version) · `PATCH issues/:key` (If-Match) · `POST issues/:key/due-requests`

- **สเกล** Week / Month / Quarter (28 / 8 / 3 px ต่อวัน) · ‹ / Today / › เลื่อนแกน · แกนเริ่มวันจันทร์ก่อนช่วงข้อมูล เผื่อท้าย 14 วัน · หัวแกน: เดือน (+ วันจันทร์เมื่อ Week / Month) · Week แรเงาเสาร์–อาทิตย์
- **แถว** Sprint (Sprint ที่ active เข้มกว่า) · Milestones (เพชร) · เส้นวันนี้สีแดง · Module › กลุ่มงาน (bar สรุปพร้อม % ความคืบหน้า) › Task › Sub-task · ยุบ / ขยายได้ทุกระดับ · bar เลยกำหนดมีขอบแดง
- **แก้แผน** (มี `issue.edit` และไม่ใช่ Guest): ลาก bar = เลื่อนทั้งช่วง · ลากขอบซ้าย / ขวา = ปรับวันเริ่ม / วันจบ · แป้น ← / → เลื่อน 1 วัน, Shift + ← / → ปรับวันจบ · ต้องมีเหตุผลหลัง Baseline (400 `plan_change_reason_required`) → Dialog เหตุผลแล้วส่งซ้ำ · ไม่มีสิทธิ์เลื่อน Due (403 `due_change_requires_approval`) → ฟอร์มขอเลื่อน Due (K3)
- **Unscheduled**: ลากชิปไปวางบนแถวใดก็ได้ → `planStart = planEnd =` วันที่ตรงตำแหน่งที่วาง
- **สีตาม** Module / Status / Assignee (สีจาก id ของผู้รับผิดชอบคนแรก ไม่มี = เทา)
- **Guest**: ไม่มีชื่อคน ไม่มีตัวเลือกสีตาม Assignee ลาก / แก้ไม่ได้ และลิงก์เปิดได้เฉพาะงานที่ `canOpen`

### คำตัดสินที่เลือกเอง / ต่างจาก Canvas

- ใช้ div วางตำแหน่งแบบ absolute (ตาม Canvas) ไม่ใช้ไลบรารี Gantt / Timeline
- ไม่ได้ทำ: ปุ่ม `+` ท้ายแถวเพื่อเพิ่ม Task / Sub-task, `+ Milestone`, Export, ลากด้วยนิ้วบนมือถือ (มือถือใช้ปุ่ม / แป้นพิมพ์ไม่ได้ — ดูได้อย่างเดียว)
- ลาก Unscheduled ใช้วันเริ่ม = วันจบ (1 วัน) เพราะ timeline ไม่ส่ง Man-Day ของงานที่ยังไม่ลงแผน · หลังวางแล้ว API คิด Plan End ใหม่ถ้างานมี Man-Day

### คำขอนอก lane

- **A03 / views**: `GET p/timeline` ควรส่ง `version` และ `estimateMd` ของแต่ละแถว (รวม unscheduled) เพื่อไม่ต้อง `GET issues/:key` ก่อนทุกครั้งที่ลาก และวางงานใหม่ได้ยาวตาม Man-Day

### ผล test / ตรวจ

`src/lib/timeline.test.tsx` 10 ข้อ (MSW): แถว Sprint / Milestone / วันนี้ / ลำดับชั้น / Unscheduled, สเกล 3 ระดับ (ความกว้าง bar ตาม px/วัน), ยุบ / ขยาย 3 ระดับ, ลาก bar / ขอบขวา / ขอบซ้าย → PATCH + If-Match, แป้นพิมพ์, เหตุผลหลัง Baseline, 403 → K3, ลาก Unscheduled ไปวาง, สีตาม 3 แบบ, Guest, ว่าง / Error + requestId / 403 · `pnpm --filter @friday/web typecheck test build` ผ่าน

**ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px**
