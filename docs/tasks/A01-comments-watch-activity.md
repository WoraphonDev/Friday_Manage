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

- [ ] test ครอบคลุมทุกข้อใน "ทำอะไร" และ "กติกา"
- [ ] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [ ] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- ส่งแจ้งเตือนจาก Event (งาน A23)
- ไฟล์แนบในคอมเมนต์ (A11)

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
