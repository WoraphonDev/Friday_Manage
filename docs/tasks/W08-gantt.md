# W08 · Gantt (SVG เขียนเอง)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A07, A02 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/gantt/**` · `apps/web/messages/th/gantt.json` |
| หน้าจอ | 5 (`design/canvas/Gantt.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · `GET p/gantt` (A07) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- WBS, Dependency arrows, Baseline overlay, Critical path, Auto-schedule preview แล้วยืนยันด้วย bulk

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

### หน้าที่เพิ่ม

- `/w/[ws]/p/[key]/gantt` → `_components/gantt-view.tsx` (client) + `gantt.module.css` · ข้อความ `messages/th/gantt.json` (namespace `gantt`)
- ตาราง WBS ซ้าย (WBS, Task, Owner, MD, Start, End, %, Pred.) ติดซ้ายตอนเลื่อน + แกนวันขวา (หัวสัปดาห์ / วัน, เสาร์–อาทิตย์แรเงา, เส้นวันนี้) · Module › กลุ่มงาน › Task › Sub-task · Module, กลุ่มงาน และงานแม่เป็น Summary bar · Milestone เป็นข้าวหลามตัดต่อท้าย Module ของตัวเอง
- เส้น Dependency วาดด้วย SVG แบบมุมฉากตาม Canvas รองรับ FS / SS / FF / SF (ถอยอ้อมเมื่อ bar ชิดกัน) · Critical path: bar แดงอ่อน + เส้นแดง ปิด/เปิดได้ · aria-label ของ bar บอกวัน, %, critical, slack, เลยกำหนด, ช้า/เร็วกว่า Baseline
- "แผน vs จริง": เลือก Baseline ล่าสุดให้อัตโนมัติ (Canvas เปิดไว้) เปลี่ยน version ได้ด้วย Select · แถบ Baseline สีเทาใต้ bar + ป้าย `+N วัน` เมื่อช้ากว่าแผน
- "ตั้งเป็นแผนใหม่ (Baseline vN)" → Dialog ใส่ชื่อ (ไม่บังคับ) → แสดงผลเทียบกับ version ใหม่ทันที
- Auto-schedule → Dialog ตัวอย่าง (เดิม → ใหม่, เลื่อนกี่วันทำการ, เพราะงานไหน, วันจบโปรเจกต์ก่อน/หลัง, warnings) → ยืนยันแล้ว PATCH ทีละงาน
- Scale Day (21 px/วันตาม Canvas) / Week / Month · Expand level 1 (Module) / 2 (+กลุ่มงาน) / 3 (ถึง Sub-task) · ปุ่ม Today เลื่อนไปวันนี้
- แถบเตือนสีส้ม: จำนวนงานเลยกำหนด, งานช้ากว่า Baseline, Dependency ที่ถูกข้ามเพราะผูกงานแม่ + ลิงก์ "ดู Workload →" ไปหน้า Members
- ชื่องานและ bar ลิงก์ `?issue=KEY` บนเส้นทาง Gantt (เปิด IssueDrawer ของ layout)

### API ที่ใช้

- `GET w/:ws/projects/:key/my-permissions` · `GET .../gantt` และ `.../gantt?baseline=vN` (A07: `critical`, `slackDays`, `baseline`, `slipDays`, `dependencies[]`, `criticalPath`, `baselines[]`, `ignoredDependencies`)
- `POST .../baselines { name? }` (ต้องมี `project.baseline`) · `POST .../schedule/preview` (ต้องมี `issue.edit`)
- ยืนยัน Auto-schedule: `GET w/:ws/issues/:key` (เอา version) → `PATCH w/:ws/issues/:key { planStart, planEnd, planChangeReason? }` + If-Match ทีละงาน · 400 `plan_change_reason_required` → ถามเหตุผลครั้งเดียวแล้วใช้กับงานที่เหลือทั้งรอบ · 403 `due_change_requires_approval` → สรุปท้าย Dialog พร้อมปุ่ม "ขอเลื่อน Due" (`POST w/:ws/issues/:key/due-requests { requestedDue, reasonCode, detail? }`) · 409 และ error อื่นแสดงเป็น "บันทึกไม่สำเร็จ" ต่องาน

### สถานะและสิทธิ์

- กำลังโหลด (LoadingState), ว่าง (EmptyState), Error พร้อม requestId (ErrorState + ลองใหม่), 403 → Forbidden
- Guest (`guestViewer`) → Forbidden ทันทีโดยไม่เรียก `GET gantt` (API ตอบ 403 `guest_view_limited` อยู่แล้ว)
- ซ่อนปุ่ม Auto-schedule เมื่อไม่มี `issue.edit` และซ่อน "ตั้งเป็นแผนใหม่" เมื่อไม่มี `project.baseline` · ปุ่ม "แผน vs จริง" ปิดไว้เมื่อยังไม่มี Baseline

### ต่างจาก Canvas / คำตัดสินที่เลือกเอง

- ปุ่ม Auto-schedule ใน Canvas เป็น toggle (aria-pressed) · ทำเป็นปุ่มเปิด Dialog ตัวอย่างแล้วยืนยัน เพราะ API ไม่บันทึกจนกว่าจะ PATCH และไฟล์งานระบุ "preview แล้วยืนยัน"
- ยืนยันด้วย PATCH ทีละงาน ไม่ใช่ bulk: `POST issues/bulk` ยังรับวันต่างกันต่องานไม่ได้ (ตามคำขอนอก lane ของ A07 ถึง A03)
- "ตั้งเป็นแผนใหม่" ใน Canvas ลิงก์ไปหน้า Import Excel · ทำเป็น Dialog ที่เรียก `POST baselines` ตรง (Import เป็นงาน W14)
- คอลัมน์ MD ใน Canvas คำนวณจากจำนวนวันทำการของช่วง · ใช้ `estimateMd` (Man-Day ที่ประเมินไว้) ตามธรรมเนียมใน `docs/decisions.md` · ไม่มีค่าแสดง "—"
- วันหยุดของ Workspace/โปรเจกต์ (Canvas แรเงา 7 และ 10 ธ.ค.) ไม่ได้แรเงา เพราะ response ของ `gantt` ไม่มีรายการวันหยุด แรเงาเฉพาะเสาร์–อาทิตย์ (ค่า slack / Auto-schedule จาก API คิดวันหยุดถูกแล้ว)
- แถบเตือน Canvas พูดถึงงานซ้อนเกิน capacity ของคน · API ของ Gantt ไม่มีข้อมูล Workload จึงเตือนเฉพาะงานเลยกำหนด / ช้ากว่า Baseline / Dependency ที่ถูกข้าม แล้วลิงก์ไปหน้า Members
- ไม่ทำปุ่ม Export PDF และการลากสร้าง Dependency จากปลาย bar (ข้อความใน legend ของ Canvas) เพราะไม่อยู่ใน "ทำอะไร" และยังไม่มี endpoint ส่งออก PDF · ไม่ทำลากเลื่อนวันบน Gantt (ทำได้ใน Timeline W07)
- WBS นับใหม่ทุกครั้งตามลำดับที่ API ส่ง (1, 1.1, 1.1.1, 1.1.1.1) และกลุ่มงานได้เลขเสมอ (Canvas บาง Module ข้ามระดับกลุ่มงาน) · Pred. แสดงเป็น WBS + ชนิด + lag เช่น `1.1.1 FS+2`
- Expand level 3 รวม Sub-task ด้วย (Canvas มี 3 ระดับ)
- มือถือ (≤ 760 px) ซ่อนคอลัมน์ Owner–Pred. เหลือ WBS + Task กว้าง 200 px แล้วเลื่อนแกนวันแนวนอน
- งาน Unscheduled ไม่แสดงบน Gantt บอกจำนวนท้าย legend ให้ไปจัดใน Timeline

### คำขอนอก lane

- **A03**: `POST issues/bulk` แบบ `items: [{ key, planStart, planEnd }]` + `planChangeReason` เพื่อยืนยัน Auto-schedule ในธุรกรรมเดียว (ตอนนี้ถ้าบางงานล้ม ผลจะเป็นบางส่วน หน้าเว็บสรุปให้ผู้ใช้เห็น)
- **A07 (ไม่บังคับ)**: ส่งวันหยุดในช่วงแกน (`holidays: string[]`) มากับ `GET gantt` เพื่อแรเงาตาม Canvas · ส่ง `version` ของงานในแถวเพื่อไม่ต้อง `GET issue` ก่อน PATCH

### ผล test

- `src/lib/gantt.test.tsx` 9 ข้อ (MSW): WBS + คอลัมน์ + Summary bar + Milestone + ขนาด bar · Scale / Expand level · เส้น Dependency + Critical path เปิด/ปิด · Baseline เลือกล่าสุดอัตโนมัติ, เปลี่ยน version, slip, ปิด · ตั้ง Baseline · Auto-schedule ตัวอย่าง → PATCH พร้อม If-Match, ถามเหตุผลแล้วส่งซ้ำ, ต้องอนุมัติ → ขอเลื่อน Due · Viewer ไม่เห็นปุ่ม · ว่าง / Error requestId / 403 / Guest · unit ของ `depPath`
- `pnpm --filter @friday/web typecheck` ผ่าน · `test` ผ่าน 12 ไฟล์ 156 ข้อ · `build` ผ่าน
- **ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440/390 px** (จึงยังไม่ติ๊กข้อแรก)
