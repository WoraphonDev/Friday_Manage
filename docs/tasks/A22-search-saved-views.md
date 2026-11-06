# A22 · ค้นหา, การค้นหาที่บันทึก และ View ที่บันทึก

| | |
|---|---|
| Wave | 2 · รองานที่ระบุ |
| รอ merge | T00 |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/search/**` · `apps/api/test/search.e2e.test.ts` |
| หน้าจอ | P1 (`design/canvas/Search.dc.html`) · 2 (`design/canvas/Table.dc.html`) |
| สเปก | 03-api › 3.9 แถว `w/search`, `w/saved-searches`, `p/saved-views` |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET w/search?q&type&project&limit`: ชื่อ / รายละเอียดงาน, Issue key (`#DP-39`), คอมเมนต์, ชื่อไฟล์, โปรเจกต์, คน (`@ชื่อ`) · ใช้ index trigram จาก T00 · Command palette ใช้ `limit=8`
- `CRUD w/saved-searches` (ของตัวเอง) · `CRUD p/saved-views` (ของตัวเอง หรือแชร์ทั้งโปรเจกต์ด้วย `project.views.share`)

## กติกาที่ต้องตรง

- กรองตามสิทธิ์ก่อนตอบ (RLS + Guest)

## เสร็จเมื่อ

- [x] test: คำค้นภาษาไทย 3 ตัวอักษร, Guest ไม่เห็นงานที่ไม่ได้แชร์
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ข้อความในไฟล์

## บันทึกผล

### Endpoint ที่เพิ่ม (`apps/api/src/search/`)

| Method | Path | สิทธิ์ | หมายเหตุ |
|---|---|---|---|
| GET | `w/:ws/search?q&type&project&limit&archived&sort` | สมาชิก | `type` = task · sub · bug · project · comment · file · person · `limit` 1–100 (ค่าเริ่มต้น 20, Command palette ใช้ 8) · `sort` = relevance (ค่าเริ่มต้น) · updated · due · `archived=true` รวมโปรเจกต์ที่ Archive |
| GET / POST | `w/:ws/saved-searches` | self | จำกัด 50 รายการต่อคน (422 `saved_search_limit`) |
| PATCH / DELETE | `w/:ws/saved-searches/:id` | self | ของคนอื่น 404 |
| GET / POST | `w/:ws/projects/:key/saved-views` | `project.view` (Guest 403) | GET = ของฉัน + ที่แชร์ทั้งโปรเจกต์ (`shared`, `mine`) · POST `shared: true` ต้องมี `project.views.share` (Admin โปรเจกต์) · จำกัด 50 |
| PATCH / DELETE | `w/:ws/projects/:key/saved-views/:id` | เจ้าของ หรือ `project.views.share` สำหรับ View ที่แชร์ | ของคนอื่นที่ไม่ได้แชร์ 404 · เปลี่ยน `shared` ได้ (เป็นแชร์ต้องมีสิทธิ์แชร์) · โปรเจกต์ Archive แก้ไม่ได้ |

#### รูปแบบผลค้นหา

`{ q, total, counts{ชนิด→จำนวน}, items[] }` · แต่ละ item มี `type` และ: งาน/sub/bug = `key, title, project, status, priority, planEnd, matchedIn (title|description), snippet` · project = `key, name, color, archived, goliveDate` · comment = `issueKey, issueTitle, project, commentId, snippet` · file = `id, name, kind, mime, project` · person = `id, displayName, initials, avatarUrl, email, jobTitle`

### กติกาการค้นหา

- `#DP-39` / `dp-39` = Issue key ตรงตัว (คะแนนสูงสุด) · `@ชื่อ` = ค้นคน (ชื่อหรืออีเมล) · อื่น ๆ ค้นแบบ contains ไม่สนตัวพิมพ์ ในชื่อ + รายละเอียดของงาน, ชื่อโปรเจกต์/Key, คอมเมนต์, ชื่อไฟล์, ชื่อคน
- `%` `_` `\` ในคำค้นเป็นตัวอักษรธรรมดา (escape ก่อน `ILIKE`)
- ความตรง: key ตรง 100 > ชื่อเท่ากัน 90 > Key โปรเจกต์ตรง 80 > คน (`@`) 70 > ชื่อขึ้นต้น 60 > … > ชื่อมี 40 > รายละเอียด 20 > คอมเมนต์/ไฟล์ 15 · เท่ากันเรียงอัปเดตล่าสุดก่อน
- **สิทธิ์**: RLS ตัดโปรเจกต์ที่เข้าไม่ได้ (รวม Private ที่ไม่ได้เป็นสมาชิก) · Guest Viewer เห็นเฉพาะงานที่แชร์และไม่ใช่ Bug, ไม่เห็นคอมเมนต์ ไฟล์ และรายชื่อคน · งานที่ลบแล้วไม่ขึ้น · โปรเจกต์ Archive ไม่รวมจนกว่าจะขอ

### คำตัดสินที่เลือกเอง

- ใช้ `ILIKE '%…%'` ซึ่ง Postgres ใช้ index trigram ที่ T00 สร้าง (`issues.title/description`, `comments.body`, `files.name`) ได้ตามชนิดคำค้น · คำสั้น/ภาษาไทยที่ trigram ไม่ตัดได้จะ scan ตามปกติ ผลถูกต้องเท่ากัน · ตัวผลลัพธ์ดึงต่อชนิดไม่เกิน 500 งาน / 200 คอมเมนต์ / 200 ไฟล์ แล้วจัดอันดับในแอป ตัวเลข `counts` จึงสูงสุดตามเพดานนี้
- ข้อความในไฟล์อยู่นอกงานนี้ (ตามไฟล์งาน)
- Saved view: `owner_id = null` คือแชร์ทั้งโปรเจกต์ ตาม 01-entities · `viewType` = table · board · timeline · gantt · calendar · backlog

### คำขอนอก lane

- **W16 / W05**: Command palette เรียก `search?q=&limit=8` · ปุ่ม "บันทึกการค้นหานี้" เรียก `POST saved-searches` · หน้า Table เรียก `saved-views` · ยังไม่มีรหัสคำสั่ง (`>` คำสั่ง) ใน API เป็นรายการคงที่ฝั่งหน้าเว็บ

### ผล test

`apps/api/test/search.e2e.test.ts` 12 ข้อ: คำไทย 3 ตัวอักษร (ชื่อ/รายละเอียด/คอมเมนต์/ไฟล์) · key `#DP-n` · `@ชื่อ` · โปรเจกต์ · ตัวกรอง type/project · limit/sort · `%` `_` ในคำค้น · **Guest ไม่เห็นงานที่ไม่แชร์ คอมเมนต์ ไฟล์ คน** · Archive/Private/ลบแล้ว · saved-searches (ของตัวเอง, จำกัด 50) · saved-views (ส่วนตัว/แชร์, สิทธิ์แชร์, แก้/ลบ, Guest, Archive) · `pnpm typecheck` ผ่าน
