# A15 · Import Excel โหมดอัปเดตแผน และ Export

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | — เริ่มได้เลย |
| Lane (แก้ได้เฉพาะ) | `apps/api/src/imports/**` · `apps/api/test/imports.e2e.test.ts` |
| หน้าจอ | L3 (`design/canvas/ImportExcel.dc.html`) |
| สเปก | 03-api › 3.6 แถว import-jobs, `p/export.xlsx` · `apps/api/src/imports/*` (โหมดสร้างใหม่ที่มีอยู่) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- โหมด `update` ของโปรเจกต์ที่มีอยู่: จับคู่แถวด้วย `excel_row_no` (คอลัมน์ No.) · ผลตรวจแสดงงานใหม่ / เปลี่ยน (รายฟิลด์) / หายไปจากไฟล์ · commit แก้งาน + เขียน `plan_changes` (source import) · ต้องมี `project.baseline`
- `GET p/export.xlsx` 18 คอลัมน์แบบไฟล์แผนต้นฉบับ (ID, No., Module, Sprint = กลุ่มงาน, …) และชีต Holidays · นำเข้าไฟล์ที่ export กลับมาได้ผลเท่าเดิม
- Event `import.completed`

## กติกาที่ต้องตรง

- งานที่หายไปจากไฟล์ไม่ลบอัตโนมัติ: แสดงในผลตรวจให้เลือก

## เสร็จเมื่อ

- [x] test: export แล้ว import อัปเดตด้วยไฟล์เดิม = ไม่มีอะไรเปลี่ยน · แก้ Man-Day 1 แถวแล้วได้ plan_change 1 รายการ
- [x] `pnpm typecheck` และ `pnpm test` ผ่านทั้งหมด (รวม test เดิม)
- [x] test ของงานนี้อยู่ในไฟล์ของ lane และเริ่มจาก `startApp()` + `seedTeam()` ใน `test/helpers.ts`

## ไม่อยู่ในงานนี้

- commit แบบ async + ความคืบหน้า (หลัง A16 / A17)

## บันทึกผล

### Endpoint (`apps/api/src/imports/`)

| Method | Path | หมายเหตุ |
|---|---|---|
| POST | `w/:ws/import-jobs` (multipart: `file`, `mode=update`, `projectKey`) | โหมดอัปเดต · ต้องมี `project.baseline` ของโปรเจกต์นั้น · ตรวจสิทธิ์ก่อนเก็บไฟล์ · `mode` อื่นนอก create/update → 400 `mode_not_supported` · ไม่ส่ง `projectKey` → 400 `project_required` |
| PATCH | `w/:ws/import-jobs/:id` | เพิ่ม `missing {"<No.>": "keep"\|"delete"}`, `missingAll`, `planChangeReason` (โหมดอัปเดต) · แก้ `columnMapping` / `personMapping` ได้เหมือนเดิม |
| POST | `w/:ws/import-jobs/:id/commit` | ตรวจสิทธิ์ซ้ำ + ล็อกต่อโปรเจกต์ + ตรวจ diff ใหม่ก่อนเขียน · คืน `{ mode, project, added, changed, unchanged, deleted, kept, planChanges, skipped, invitations }` |
| GET | `w/:ws/projects/:key/export.xlsx` | `project.view` (Guest 403 `guest_view_limited`) · ชีต `Table` 18 คอลัมน์ (ID, No., Module, Sprint, Module Task, Screen ID, FR / NFR, BA, Status, Dev, Size, Man-Day, Plan Start, Plan End, Actual Start, Actual End, Remark, Working Days) + ชีต `Holidays` (ปฏิทินของโปรเจกต์/Workspace + วันหยุดโปรเจกต์) · เฉพาะ Task ระดับบนที่ไม่ถูกลบ ไม่รวม Sub-task/Bug |

**ผลตรวจของโหมดอัปเดต** (`diff` ใน job): `added[]`, `changed[] {no,key,title,fields[{field,label,old,new}]}`, `missing[]` (อยู่ในระบบแต่ไม่อยู่ในไฟล์), `unchanged` · เทียบ title, Module, กลุ่มงาน, Status, Size, Man-Day, Plan/Actual Start/End, BA, Dev, Remark

**Commit**: แก้งานที่เปลี่ยน (Sub-task ย้ายตาม Module/กลุ่มงาน), เพิ่มงานใหม่ (สร้าง Module/กลุ่มงาน/Requirement/Screen ที่ยังไม่มี), ลบเฉพาะงานที่หายและผู้ใช้เลือก `delete` (ถังขยะ 30 วัน) · ฟิลด์แผน (planStart, planEnd, estimateMd, assigneeIds) เขียน `plan_changes` source `import` เทียบ Baseline ล่าสุด · Activity ทุกฟิลด์ · ส่ง `import.completed` (ทั้งโหมด create และ update) และ `plan.changed` / `issue.created` / `issue.deleted` ต่องาน

### คำตัดสินที่เลือกเอง

- **Plan End ใช้ค่าในไฟล์** เมื่อมี (เตือนถ้าไม่ตรงกับที่คำนวณ) ต่างจากโหมด create ที่คำนวณทับ เพื่อให้ export → import ไม่เปลี่ยนค่า และแก้ Man-Day แถวเดียวได้ plan_change เดียว
- Size ว่างในไฟล์ = ว่าง (ไม่คำนวณจาก Man-Day) และ BA ว่างเป็นแค่คำเตือน เพราะงานที่สร้างในระบบอาจไม่มี
- งานที่สร้างในระบบยังไม่มี No.: export ให้ No. ต่อจากเลขสูงสุด, import จับคู่ด้วย ID (เลขงาน) แล้วบันทึก `excel_row_no` ให้ครั้งต่อไปจับคู่ด้วย No.
- เทียบ Dev/BA ด้วยชื่อ (ไม่สนตัวพิมพ์) ส่วนตอนเขียนใช้ userId จากการจับคู่คน; ชื่อที่ไม่พบไม่ถูกเพิ่ม และสมาชิกเดิมที่ยังอยู่ในไฟล์ไม่ถูกถอด
- ไม่เทียบ Screen ID / FR ตอนอัปเดต (แก้ในระบบได้เอง) · ใช้กับแถวใหม่เท่านั้น
- ไม่มี Baseline = ไม่เขียน plan_changes (กติกาเดียวกับ `PATCH issues/:key`) · เหตุผลเริ่มต้น "อัปเดตแผนจากไฟล์ <ชื่อไฟล์>"
- แถวที่ต้องแก้ (error) ถูกข้าม และไม่นับเป็นงานที่หายไป

### Checklist ในไฟล์ (ผู้ใช้ตัดสิน 2026-11-13)

- คอลัมน์ `Checklist` (ชีต Tasks ต่อจาก Title) 1 แถวต่อ 1 ข้อ: ข้อแรกอยู่ในแถวของงาน ข้อถัดไปเป็นแถวต่อท้ายที่ Title เดียวกันติดกัน (Module / Key / No. / Parent Key ว่างหรือเหมือนแถวงาน) · ค่าในคอลัมน์อื่นของแถวต่อท้ายไม่ถูกใช้และเตือน · แถวต่อท้ายที่ไม่มี Checklist ถูกข้ามและเตือน
- ข้อที่ขึ้นต้น `[Acceptance]` เข้า `checklist_items.kind = acceptance` ข้ออื่นเป็น `checklist` · คงคำขึ้นต้น `[..]` ไว้ในข้อความ · ตัดช่องว่างหน้า/ท้ายแต่ละบรรทัด · ยาวเกิน 5,000 ตัวอักษร = แถวงานต้องแก้
- โหมดอัปเดต Sync ตามข้อความ (ชนิด + ข้อความ): ข้อที่ตรงกันคงไว้พร้อมสถานะติ๊ก · ข้อใหม่ต่อท้าย · ข้อที่หายจากไฟล์ลบเฉพาะที่ยังไม่ติ๊ก (ติ๊กแล้วเก็บไว้และเตือน) · ไฟล์ไม่มีคอลัมน์ Checklist = ไม่แตะของเดิม · ใน diff เป็นฟิลด์ `checklist` ค่า "N ข้อ" → "M ข้อ (เพิ่ม x · ลบ y)"
- Export / Template มีคอลัมน์ Checklist และส่งออกแถวต่อท้ายแบบเดียวกัน (Checklist ก่อน Acceptance) จึงนำเข้ากลับได้ไม่เปลี่ยน · `summary.checklist` และผล commit `checklist` = จำนวนข้อ
- นอก lane: หน้า L3 แสดง "N งาน · Checklist M ข้อ" ตอนอัปโหลด และจำนวนข้อที่เพิ่มในหน้าเสร็จ (`apps/web/app/work/[ws]/import/_components/*` + ข้อความ th/en)

### แทนที่แผนเดิม = ลบแล้วสร้างใหม่ (ผู้ใช้ตัดสิน 2026-11-14)

- `updateKind=replace` (การ์ด "แทนที่แผนเดิม" ในหน้า L3): Task ระดับบนทุกงานพร้อม Sub-task ย้ายถังขยะ (กู้คืนได้ 30 วัน) ก่อน แล้วสร้างทุกแถวในไฟล์เป็นงานใหม่ · ไม่มีให้เลือกเก็บ · งานชนิดอื่นที่สร้างในระบบ (เช่น Bug ระดับบน) คงไว้
- เลขงานใหม่ต่อจากเลขล่าสุด เพราะงานในถังขยะยังถือเลขเดิมไว้ให้กู้คืน (ผู้ใช้เลือกแบบนี้แทนการลบถาวรเพื่อใช้ Key ในไฟล์) · No. ในไฟล์รูปแบบเดิมใช้ซ้ำได้ (ปล่อยจากงานที่ลบ)
- Sub-task ต้องมี Task แม่ในไฟล์ (อ้างงานเดิมไม่ได้เพราะถูกลบ) · ไม่เขียน `plan_changes` (ไม่มีงานเดิมให้เทียบ)
- Module / กลุ่มงานเดิมที่ไม่มีในไฟล์และไม่เหลืองานถูกลบด้วย (ผู้ใช้ทักว่ากลุ่มเปล่าของแผนเก่าค้าง) · งานในถังขยะและ Milestone ที่อ้างถึงถูกถอดออก (กู้คืนแล้วไม่มี Module / กลุ่ม แบบเดียวกับการลบ Module ในหน้าตั้งค่า) · ผลตรวจมี `diff.removedModules` / `removedGroups` · ผล commit มี `removedModules` / `removedGroups`
- การจับคู่และแก้งานเดิมแบบเดิมย้ายไปเป็น `updateKind=sync` ใช้ผ่าน API และเป็นค่าเริ่มต้นเมื่อไม่ส่ง updateKind เพื่อไม่ให้ client เดิมลบแผนโดยไม่ตั้งใจ

### คำขอนอก lane

- **W (หน้า L3)**: ปุ่ม Export ใช้ `GET projects/:key/export.xlsx` · อัปเดตแผนส่ง `mode=update` + `projectKey` · แสดง `diff` และให้เลือก keep/delete ของ `missing`
- **D99**: เพิ่ม `export.xlsx`, `mode=update`/`projectKey`, `diff`, `missing` ใน 03-api 3.6
- commit แบบ async + ความคืบหน้า (`import:{jobId}` ของ A17 ใช้ `RealtimeService.publish`) ยังไม่ทำ ตามขอบเขตงาน

### ผล test

`apps/api/test/imports.e2e.test.ts` 9 ข้อ: create → export (18 คอลัมน์ + Holidays, สิทธิ์) · export แล้ว import อัปเดตด้วยไฟล์เดิม = ไม่เปลี่ยนอะไร (ไม่มี activity/plan_change เพิ่ม) · แก้ Man-Day 1 แถว = plan_change 1 รายการ (source import, ผูก Baseline) · แก้ชื่อ/สถานะ/Dev/วัน แจกแจงรายฟิลด์ + เหตุผลที่ระบุเอง · งานใหม่ + งานที่หาย keep/delete + เลขงานถัดไป · แถว error ข้าม + missingAll · สิทธิ์ (member 403, ถอดสิทธิ์ระหว่างทาง 403, ไม่ใช่เจ้าของ job 404) · งานที่สร้างในระบบจับคู่ด้วย ID · `pnpm typecheck` ผ่าน · API 461 ผ่าน (ข้าม 6 = เดิม)
