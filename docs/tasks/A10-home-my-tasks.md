# A10 · Home และ My Tasks

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/home/**` · `apps/api/test/home.e2e.test.ts` |
| หน้าจอ | E (`design/canvas/Home.dc.html`) · F (`design/canvas/MyTasks.dc.html`) · M2 (`design/canvas/MobileMyTasks.dc.html`) · M5 (`design/canvas/MobileHome.dc.html`) |
| สเปก | 03-api › 2 หน้า E และ F |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/home`: สรุปวันนี้ (ครบกำหนดวันนี้ / เลยกำหนด / กำลังทำ ของฉัน), รออนุมัติ (ใช้ `DueRequestsService.list` โดย import `DueRequestsModule`), รอ Review (ฉันเป็น Reviewer และสถานะชื่อ Review), โปรเจกต์ของฉันพร้อมความคืบหน้า, งานที่ฉันแตะล่าสุด (จาก `activities`), ครบกำหนดใน 30 วัน
- `GET w/my-issues?tab=assigned|reviewer|watching|created&group=due|project|status` · group=due แบ่ง เลยกำหนด / วันนี้ / สัปดาห์นี้ / สัปดาห์หน้า / ภายหลัง / ไม่มีวันที่
- ถ้า A08 merge แล้ว ใช้ `overview/workload.ts` แสดง Workload สัปดาห์นี้ของฉันใน Home

## กติกาที่ต้องตรง

- ข้ามทุกโปรเจกต์ที่เข้าถึงได้ (RLS) · Guest ที่เป็น Viewer เห็นเฉพาะงานที่แชร์

## เสร็จเมื่อ

- [x] test ครอบคลุมทุก tab และ group
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/home/`) · สมาชิกทุกคน รวม Guest (จำกัดข้อมูล)

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `w/:ws/home` | หน้า E / M5 |
| GET | `w/:ws/my-issues?tab=assigned\|reviewer\|watching\|created&group=due\|project\|status&projectKey=&assignee=` | หน้า F / M2 · `tab` ค่าเริ่มต้น `assigned`, `group` ค่าเริ่มต้น `due` |

#### `GET home`

- `today`, `week {start,end}` (จันทร์–อาทิตย์)
- `summary`:
  - `dueToday {team, mine, keys[≤5]}`, `overdue {team, mine, byAssignee[{person,count}≤5]}`, `dueThisWeek {team, mine, until}` (`until` = ศุกร์ของสัปดาห์ ตาม Canvas "ถึง ศ. 4 ธ.ค." · นับตั้งแต่วันนี้ถึงสิ้นสัปดาห์), `inProgress {mine}`, `waitingReview`, `unreadMentions {count, latestFrom}`, `pendingApprovals`
  - **ทีม** = งานในโปรเจกต์ที่ฉันเป็นเจ้าของหรือเป็นสมาชิกจริง (ไม่นับโปรเจกต์ที่แค่ visibility ให้เห็น) · **ของฉัน** = งานที่ฉันเป็น Assignee ในทุกโปรเจกต์ที่เข้าถึงได้ · นับเฉพาะงานที่ยังไม่เสร็จและมี Due
- `waiting.approvals`: ผลของ `DueRequestsService.list(scope=to_approve, status=pending)` ทั้งก้อน · `waiting.reviews`: ฉันเป็น Reviewer และสถานะชื่อ Review (ไม่สนตัวพิมพ์ ตรงกับ A23) พร้อม `from` = ผู้สร้างงาน
- `projects[]`: `progressPct` (นับงานระดับ Task ตาม `progress_method` count/weighted), `overdue`, `myTasks`, `goliveDate`, `daysToGolive`, `health {level, gapPct}` (ใช้ `overview/health.ts`) · เรียงใกล้ Go-live ก่อน (เรียงอื่นให้หน้าเว็บทำเอง)
- `recent[≤8]`: งานที่ฉันแตะล่าสุดจาก `activities` ไม่ซ้ำงาน (เฉพาะงานที่ยังไม่เสร็จนานและฉันยังเห็นได้)
- `upcoming[]`: 30 วันข้างหน้า เรียงตามวัน · `type` = `sprint_start` · `sprint_end` · `milestone` · `phase_end` (วันสิ้นสุดของงานสุดท้ายในกลุ่มงาน) · `holiday` (ปฏิทินหลักของ Workspace)
- `workload`: Workload สัปดาห์นี้จาก `workspaceWorkload` (A08): `team {md, capacityMd, utilizationPct}`, `mine`, `people[≤10]` เรียงมากไปน้อย

#### `GET my-issues`

- `counts` ของทั้ง 4 แท็บ (นับเฉพาะงานที่ยังไม่เสร็จ) · `total` = จำนวนงานที่ยังไม่เสร็จในแท็บ/ตัวกรองปัจจุบัน
- `group=due`: `late` (เลยกำหนด) · `today` · `this_week` (พรุ่งนี้–อาทิตย์) · `next_week` · `later` · `none` · `done_today` พร้อม `range {from,to}` (ภายหลัง `to` เป็น `""`) · แสดงทุกกลุ่มแม้ว่าง (`count: 0`) เพื่อให้เป็นเป้าลากงานไปเปลี่ยน Due ได้
- `group=project` (เฉพาะโปรเจกต์ที่มีงาน) · `group=status` (เรียงหมวด To do › In progress › Done แล้วลำดับใน Workflow)
- แต่ละ item: `key, title, type, project{key,name,color}, status, priority, planStart, planEnd, due{state: overdue|today|later|none|done, days}, estimateMd, parentKey, subtasks{total,done}, assignees, version` · `version` ไว้ส่ง `If-Match` ตอน `PATCH issues/:key` (ติ๊กปิดงาน / ลากเปลี่ยน Due)
- เสร็จเมื่อวานและก่อนหน้าไม่แสดง · `projectKey` ที่ไม่มี/เข้าไม่ได้ → 404 `project_not_found`

### กติกาที่ใช้

- ข้ามทุกโปรเจกต์ที่ผู้เรียกเข้าถึงได้ (RLS + `projectAccess`) ไม่รวมโปรเจกต์ที่ลบ/Archive
- **Guest Viewer**: เห็นเฉพาะงานที่แชร์ (`shared_with_guests`) และไม่ใช่ Bug · ไม่เห็นชื่อคน (`assignees: []`, `byAssignee: []`) · ไม่มี `workload` (null) และไม่มีการอนุมัติ/รีวิว

### คำตัดสินที่เลือกเอง

- สรุป "วันนี้" ให้ทั้งตัวเลขของ **ทีม** (ตาม Canvas E) และของ **ฉัน** (ตามไฟล์งาน) ในฟิลด์เดียวกัน
- Mentions ที่ยังไม่อ่าน นับจาก `notifications` (`issue.mentioned`, `read_at` และ `done_at` ว่าง) ของ Workspace นี้
- สัปดาห์เริ่มวันจันทร์ ตามที่ `overview/workload.ts` ใช้
- ไม่แยกงานของ Bug ใน My Tasks นอกจากฟิลด์ `type`

### คำขอนอก lane / หมายเหตุ

- **W03**: ติ๊กปิดงานใช้ `PATCH issues/:key` + `If-Match: "<version>"` · ลากไป "สัปดาห์หน้า" ใช้ `PATCH` (Due) หรือ `POST issues/:key/due-requests` ตามสิทธิ์ (กติกา 403 `due_change_requires_approval` ใน 03-api)
- ยังไม่มี Event/คิวใหม่ ไม่ต้องแก้ไฟล์กลาง

### ผล test

`apps/api/test/home.e2e.test.ts` 12 ข้อ (จำลองวันที่เป็น พ. 2 ธ.ค. 2569 ด้วย fake timers): ทุก tab (assigned / reviewer / watching / created) และทุก group (due ครบ 7 กลุ่มพร้อมช่วงวัน, project, status) · งานที่เสร็จวันนี้ vs เมื่อวาน · ตัวกรอง projectKey/assignee/พารามิเตอร์ผิด · ข้ามโปรเจกต์และโปรเจกต์ Private ที่ไม่ได้เป็นสมาชิก · Guest · Home: ตัวเลขทีม/ของฉัน, Overdue ต่อคน, รออนุมัติ (ผ่าน `DueRequestsService`) + รอ Review, โปรเจกต์พร้อม progress/health/Go-live, เปิดล่าสุด, 30 วันข้างหน้า (Sprint/Milestone/วันหยุด), Workload, Guest · `pnpm typecheck` ผ่าน · API 253 ผ่าน (ข้าม 6 = เดิม)
