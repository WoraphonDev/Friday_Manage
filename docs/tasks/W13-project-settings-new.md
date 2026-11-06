# W13 · Project Settings และสร้างโปรเจกต์ (Wizard)

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A04, A05 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/p/[key]/settings/**` · `apps/web/app/w/[ws]/new-project/**` · `apps/web/messages/th/project-settings-new.json` |
| หน้าจอ | L2 (`design/canvas/ProjectSettings.dc.html`) · A (`design/canvas/NewProject.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.4, 3.5 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ทุกแท็บของ L2 (เรียก endpoint รายแท็บ) รวมตารางสิทธิ์ 10 แถว · แท็บที่ API ยังไม่มีแสดงว่ายังไม่เปิด
- Wizard 5 ขั้นตามหน้า A

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

หน้าที่ทำ:

- `p/[key]/settings/[[...section]]` (L2): เมนู 8 หมวดเป็นลิงก์ `/settings/<หมวด>` (ไม่ระบุ = ทั่วไป · หมวดที่ไม่รู้จัก = NotFound) + ลิงก์ Automation เมื่อมี `project.automation` · component ใน `settings/_components/`
  - ทั่วไป: `GET p/` (cache key เดียวกับ ProjectShell) → `PATCH p/` + `If-Match` ส่งเฉพาะฟิลด์ที่เปลี่ยน (ชื่อ, Key, วันเริ่ม / Go-live, การมองเห็น, หน่วยประมาณงาน, ความยาว Sprint, Size → MD, ปฏิทินวันหยุด, เวลาทำงาน, Time log) · 409 `conflict` แสดง ConflictState และโหลด `details.latest` · เปลี่ยน Key แล้ว `router.replace` ไป URL ใหม่ · `warnings` แสดงเป็น toast · error ที่มี `details.fields` แสดงใต้ช่อง
  - Workflow: `GET workflows` แยกแท็บตามประเภทงาน · แก้ชื่อ / หมวด / WIP (`PATCH statuses/{id}`), เรียงลำดับ (`POST statuses/reorder`), เพิ่ม, ลบ (มีงานต้องเลือก `moveTo` ใน Dialog) · กฎจาก `catalog`: มีแถวที่ไม่มี config = `PATCH rules/{id}` ไม่มี = `POST rules` · Workflow Bug แสดง "แสดงบน Kanban ในคอลัมน์" จาก `boardColumnId`
  - ประเภทงาน + ฟิลด์: เปิดปิด / ฟิลด์บังคับ (`PATCH issue-types/{id}`, ตัวเลือกจาก `requiredFieldOptions`, ชื่อบังคับเสมอ) · Custom field (`POST / DELETE custom-fields`, แบบตัวเลือกส่ง `options.choices`) · Label (`POST / DELETE labels`)
  - Modules: แก้ชื่อ, Owner (สมาชิกจาก `GET p/members`), เรียงลำดับ, เพิ่ม, ลบ (มีงานต้องเลือก `moveTo`)
  - สิทธิ์ของ Role: ตาราง 10 แถว × Admin / Member / Viewer · Admin เปิดและแก้ไม่ได้ · เปลี่ยนแล้ว `PUT p/role-permissions` แบบ optimistic ล้มเหลวคืนค่าเดิม
  - Danger zone: Archive (ConfirmDialog) / กู้คืนเมื่อถูก Archive (`project.archive`) · โอนความเป็นเจ้าของ (Project Owner หรือ Workspace Owner / Admin · รายชื่อตัด Guest และเจ้าของเดิม) · ลบถาวรแสดงตัวเลขจาก `GET p/delete-impact` พิมพ์ Key ให้ตรงก่อน (ไม่สนตัวพิมพ์) แล้ว `DELETE p/ { confirmKey }` และกลับหน้า Home · `canDelete = false` แสดงว่าลบได้เฉพาะ Owner / Admin
  - การแจ้งเตือน และ Integrations: API ยังไม่มี (`p/notification-rules`, `p/repositories`) จึงแสดงหัวข้อของ Canvas พร้อม "ยังไม่เปิดใช้งาน"
- `w/[ws]/new-project` (A): Wizard 5 ขั้นตาม Canvas + กล่องสรุปด้านขวา → `POST w/projects` แล้ว `router.push` ไปหน้าโปรเจกต์ · ขั้น 1–2 บังคับ (ข้ามไปขั้นหลังได้เมื่อผ่าน) · "สร้างเลย" ได้ตั้งแต่ขั้น 2 · Key สร้างจากชื่ออัตโนมัติจนกว่าจะแก้เอง และตรวจ `GET w/projects/key-available` ตอนออกจากช่อง / กดถัดไป · 409 `key_taken` กลับขั้น 1 · error ที่ `details.fields` ชี้วันที่ / Workflow กลับขั้นนั้น · error อื่นแสดง toast พร้อม requestId (402 ส่ง event กลางของ `api` อยู่แล้ว)
  - Template: 4 แบบในตัว (Scrum = Sprint, Kanban = WIP 5 / 3, Waterfall = Module Requirement → Deploy, Blank = To do → Done) และ Template ของ Workspace จาก `GET w/project-templates` เฉพาะ Owner / Admin (`retry: false`, 403 ไม่แสดง error ใช้ Template ในตัวต่อ) · Template ของ Workspace ส่ง `templateId` และไม่ส่ง `sprintLengthWeeks` / `workflow` (ถ้าไม่แก้) เพื่อให้ค่าของ Template มีผล
  - ระยะเวลา: วันทำการ จ.–ศ. คิดฝั่งเว็บ (ยังไม่หักวันหยุด เขียนบอกในหน้า) · จำนวน Sprint คิดแบบเดียวกับ `sprintPlan` ของ API · ปฏิทินวันหยุดเลือกได้เมื่ออ่าน `GET w/holiday-calendars` ได้ (Admin) · วันหยุดบริษัท → `extraHolidays` · Milestone
  - ขอบเขต: In / Out-of-scope และ Module แบบพิมพ์แล้ว Enter · Deliverables / Acceptance / สมมติฐาน บรรทัดละข้อ → `scope`
  - ทีม: ค้นจาก `GET w/members` ด้วยชื่อหรืออีเมล (คั่นด้วย , ได้) · ตำแหน่ง, Role (Guest เลือก Admin ไม่ได้), Capacity → `members` · ผู้สร้างเป็น Owner / Admin เสมอ
  - การตั้งค่า: แก้ Workflow (เพิ่มแทรกก่อนสถานะสุดท้าย, ลบได้เหลืออย่างน้อย 2), หน่วยประมาณงาน, วิธีคิดความคืบหน้า
  - บันทึกร่าง: เก็บใน `localStorage` ของเครื่องนี้ (`friday:new-project-draft:<ws>`) โหลดกลับตอนเปิดหน้า ล้างเมื่อสร้างสำเร็จ · Guest ของ Workspace ได้ Forbidden

คำตัดสินที่ต่างจาก Canvas:

- เรียงสถานะ / Module ด้วยปุ่ม ↑ ↓ แทนการลาก (ใช้คีย์บอร์ดได้ และไม่ต้องเพิ่ม library) · คำอธิบาย Modules เปลี่ยนจาก "ลากเพื่อเรียง" ตามนั้น
- Project Owner / PM (ทั้ง L2 และขั้น 4) แสดงอย่างเดียว: API ยังไม่รับ `ownerUserId` ตอนสร้าง และการเปลี่ยน Owner คือ `POST p/transfer` ใน Danger zone
- เวลาทำงานเป็นช่องเวลา 2 ช่อง (`workStart` / `workEnd`) แทนข้อความ "จ.–ศ. 09:30–18:30" เพราะ API เก็บเป็น HH:MM · เว้นว่าง = ใช้ของ Workspace · Size → MD ที่ยังเป็น `null` แสดงค่าเริ่มต้น 1 / 3 / 5 / 8 / 12 และบอกว่าใช้ค่าของ Workspace
- ปฏิทินวันหยุด: Member อ่านรายชื่อปฏิทินไม่ได้ (Admin เท่านั้น) จึงปิดช่องเลือกพร้อมคำอธิบาย
- ขั้น 2 ปุ่มวันทำงาน แสดง จ.–ศ. แบบปิดใช้ (API ไม่มีวันทำงานรายโปรเจกต์) · ขั้น 3 กล่องแนบไฟล์, ขั้น 5 ปุ่ม Connect ของ Integrations และ "ติดตามงบประมาณ" แสดงว่ายังไม่เปิด · ขั้น 1 ไม่มีปุ่ม "เปลี่ยนไอคอน" (แสดง Key บนสีที่เลือกแทน)
- ข้อความ "ระบบจะสร้างให้อัตโนมัติ" นับจากค่าที่กรอกจริง (Module, สถานะ, Milestone, Sprint, วันหยุด, สมาชิก) แทนตัวเลขตายตัว · Template Waterfall สร้างเฟสเป็น Module เพราะ API ไม่มีเฟสระดับโปรเจกต์
- ตารางสิทธิ์เริ่มจากค่าเริ่มต้นของระบบ เพราะ API ไม่มี `GET p/role-permissions` (03-api เขียนว่า GET / PUT) · หน้าบอกไว้ใต้ตาราง

คำขอนอก lane:

1. A04: เพิ่ม `GET p/role-permissions` (ค่าที่มีผลของ Member / Viewer ทั้ง 10 แถว) ให้ตาราง L2 แสดงค่าที่ตั้งไว้จริง · `POST w/projects` ยังไม่รับ `ownerUserId`, `invites`, `requirementFileIds`, `budget` ที่ Wizard มีในหน้าจอ
2. W00 (`project-shell.tsx`): แท็บ Settings ต้องมี `project.settings` แต่โปรเจกต์ที่ถูก Archive ถูกตัดสิทธิ์นี้ (เหลือ `project.archive`) จึงเข้า Danger zone เพื่อกด "กู้คืน" ไม่ได้ · เสนอให้ยอม `/settings/danger` เมื่อมี `project.archive`
3. A18: `GET w/project-templates` และ `GET w/holiday-calendars` เป็นของ Admin · ถ้าอยากให้ Member เลือก Template / ปฏิทินตอนสร้างโปรเจกต์ ต้องมี endpoint แบบอ่านอย่างเดียว (ชื่อ + คำอธิบาย) ที่ Member เรียกได้
4. A25 / A27: แท็บ "การแจ้งเตือน" (`p/notification-rules`, `p/notification-settings`) และ "Integrations" (`p/repositories`) รอ endpoint

Test: `src/lib/project-settings-new.test.tsx` 14 tests (MSW + `WorkspaceShell`) ครอบคลุมทุกหมวดของ L2 (เมนู, หมวดที่ยังไม่เปิด, ทั่วไป + If-Match + 409 + เปลี่ยน Key, Workflow, ประเภทงาน + ฟิลด์ + Label, Modules, สิทธิ์ 10 แถว + ล้มเหลวคืนค่า, Danger zone), สถานะ Error พร้อม requestId / ไม่มีสิทธิ์ / Guest 403 รายแท็บ, Wizard ครบ 5 ขั้นจนได้ body ของ `POST w/projects`, สร้างเลยจากขั้น 2 + Sprint + validation + error, บันทึกร่าง, Guest และฟังก์ชันคำนวณ · `pnpm --filter @friday/web typecheck`, `test` (218 tests หลัง rebase) และ `build` ผ่าน

ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px (ทำ layout ตาม CSS ของ Canvas: เมนู 240 px + เนื้อหา, มือถือ ≤ 760 px เมนูเป็นแถบเลื่อนแนวนอนและซ่อนคอลัมน์รอง)
