# A01 · คอมเมนต์, @mention, Watch และ Activity ของงาน

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/comments/**` · `apps/api/test/comments.e2e.test.ts` |
| หน้าจอ | C (`design/canvas/TaskDetail.dc.html`) · D (`design/canvas/SubtaskModal.dc.html`) · K2 (`design/canvas/BugDetail.dc.html`) · M4 (`design/canvas/MobileSubtask.dc.html`) |
| สเปก | 03-api › 3.7 แถว `i/comments`, `i/activity`, `i/:watch` · 04-permissions › 3.3 คอมเมนต์ และ 4 Guest |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- `GET / POST / PATCH / DELETE w/{ws}/issues/{key}/comments` (cursor) · แยก `@ชื่อ` เป็น `comment_mentions` (เฉพาะสมาชิกโปรเจกต์) · ผู้เขียนและคนที่ถูก mention ถูก Watch อัตโนมัติ (`issue_watchers.source`)
- แก้ / ลบได้เฉพาะของตัวเอง · Admin ของโปรเจกต์ลบของคนอื่นได้ → ซ่อนเนื้อหา แสดง "ถูกลบโดย Admin" (`deleted_by`)
- `GET …/activity`: รวม `activities` + คอมเมนต์ เรียงตามเวลา พร้อมข้อมูลคน `{ id, displayName, initials, avatarUrl }` · คืนค่าดิบ (verb, field, old, new) ให้หน้าเว็บแปลข้อความเอง
- `POST / DELETE …/watch` (ตัวเอง) · `GET …/watchers`
- Event หลัง commit: `issue.commented` (`commentId`, ข้อความย่อ 140 ตัว) และ `issue.mentioned` (`userIds`)

## กติกาที่ต้องตรง

- เขียนคอมเมนต์ต้องมี `issue.comment` · Guest ที่เป็น Viewer คอมเมนต์ได้เฉพาะงานที่แชร์ และเห็นผู้เขียนฝั่งทีมเป็น "ทีมพัฒนา" (ไม่มี id)
- mention คนนอกโปรเจกต์ → 400 `invalid_mention`

## เสร็จเมื่อ

- [x] test ครอบคลุมทุกข้อใน "ทำอะไร" และ "กติกา"
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งแจ้งเตือนจาก Event (งาน A23)
- ไฟล์แนบในคอมเมนต์ (A11)

## บันทึกผล

- เพิ่ม `GET/POST comments`, `PATCH/DELETE comments/{id}`, `GET activity`, `GET watchers` และ `POST/DELETE watch` ใต้ `w/{ws}/issues/{key}` · ทุก query ผ่าน `TenantDb.run` และตรวจสิทธิ์โปรเจกต์
- คอมเมนต์และ Activity เรียงจากเก่าไปใหม่ แบ่งหน้าด้วย `{ items, nextCursor }` · cursor ผูกกับงานและชนิด feed ใช้เวลาเต็มจาก PostgreSQL + id เพื่อไม่ตกหล่นในมิลลิวินาทีเดียวกัน · Activity คืน `kind`, `actor`, `actorKind`, `verb`, `field`, `old`, `new` และเวลา ส่วนคอมเมนต์คืน `author`, `mentions` และสิทธิ์แก้/ลบของผู้เรียก
- รองรับ `@ชื่อ` ตาม Canvas รวมชื่อหลายคำ/ภาษาไทย และ `@[ชื่อ](UUID)` สำหรับคนชื่อซ้ำ · mention ต้องตรงสมาชิกโปรเจกต์ที่ยัง active (รวม Project Owner) · ไม่ตีความอีเมลเป็น mention · แก้คอมเมนต์จะปรับตาราง mentions และส่ง `issue.mentioned` เฉพาะคนที่เพิ่มใหม่ ไม่เลิก Watch คนที่เคยถูก mention
- Auto-watch ผู้เขียนและคนที่ถูก mention โดยรักษา source เดิม · กด Watch เองเปลี่ยนเป็น `manual` · Unwatch กระทำกับผู้เรียกเท่านั้นและเรียกซ้ำได้
- ลบคอมเมนต์เป็น tombstone (`body: null`, `deletionReason: author|admin`, `deletedBy`) และล้างข้อความ/mentions ที่บันทึกไว้ · แก้ของคนอื่นไม่ได้แม้เป็น Admin · Guest Viewer คุยได้เฉพาะงานที่แชร์และไม่ใช่ Bug โดยซ่อนตัวตนทีมในผู้เขียน, mentions, ผู้ลบ, watchers และค่าคนใน Activity
- ส่ง `issue.commented` หลัง commit เฉพาะตอนสร้าง พร้อม excerpt 140 Unicode code points และ `issue.mentioned` หลัง commit · ไม่ส่งแจ้งเตือนเอง (A23)
- ตรวจด้วย `startApp()` + `seedTeam()` ใน `comments.e2e.test.ts` 11 กรณี ครอบคลุม CRUD/เจ้าของ/Admin, mention ที่ไม่ถูกต้อง/ชื่อซ้ำ/ปิดสมาชิก, cursor และเวลาเท่ากัน, Activity, Watch, Event หลัง commit, Guest และการแยก Workspace/งาน
- ผลตรวจ: `pnpm typecheck` ผ่านทุกแพ็กเกจ · `pnpm test` ผ่าน Web 31, DB 105, API 65 tests (มี 2 tests เดิมที่ skip) · ใช้ฐานทดสอบแยก `friday_a01` ไม่ชนงานขนาน
- ไม่มีการแก้ schema หรือไฟล์กลางนอก lane
