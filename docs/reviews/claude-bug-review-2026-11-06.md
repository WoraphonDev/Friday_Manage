# รายการ Bug สำหรับ Claude แก้ไข — 6 พฤศจิกายน 2026

## ขอบเขตและผลตรวจ

ตรวจงานที่ checklist เสร็จแล้ว 32 งานใน `docs/tasks/` รวม A17 ที่เสร็จเพิ่มระหว่างการตรวจ โดยอ่านโค้ดจุดสำคัญของแต่ละโมดูล ตรวจการเชื่อมต่อข้ามโมดูล รันชุดทดสอบเดิม และเพิ่มกรณีจำลองเพื่อยืนยันปัญหา ไม่ได้แก้โค้ดผลิตภัณฑ์ในรอบนี้

เริ่มตรวจที่ `2572b8b` (A17 ก่อน merge) และยืนยันรายการกับ `16756c0` (A17, PR #35) ประวัติ Git ใช้ชื่อผู้เขียนเดียวกัน จึงใช้ขอบเขตงานที่เสร็จเป็นตัวแทนของ “งานที่ Claude ทำ” ไม่สามารถแยกผู้สร้างโค้ดจากชื่อ Git author ได้

**พบ 14 รายการ: P1 = 6 รายการ, P2 = 8 รายการ** ทุกข้อมีหลักฐานจากโค้ดและกรณีทดสอบจำลอง ไม่ได้ทดสอบเจาะบริการภายนอกจริง

| การตรวจ | ผล |
|---|---|
| `pnpm typecheck` | ผ่านทั้ง Web, DB และ API บน snapshot เริ่มตรวจ |
| `pnpm test` — Web | 109 ผ่าน / 7 ไฟล์ |
| `pnpm test` — DB | 107 ผ่าน / 4 ไฟล์ |
| `pnpm test` — API | 452 ผ่าน, 6 skipped / 28 ไฟล์ผ่าน, 1 ไฟล์ skipped |
| กรณีจำลองเพิ่มเติม R01–R14 | 14 ผ่าน คือยืนยันว่าโค้ดปัจจุบันแสดงพฤติกรรมผิดตามรายงาน |
| `pnpm -r --if-present build` | หยุดด้วย Ctrl-C หลังค้างที่ Next.js “Creating an optimized production build”; ยังสรุปผล build ไม่ได้ และไม่นับเป็น bug ที่ยืนยันแล้ว |

ใช้ฐานข้อมูลแยก `friday_codex_review_20261106` ไม่ล้างฐาน `friday` หลัก กรณีทดสอบเพิ่มใช้ไฟล์ใน `/private/tmp/friday-codex-review-uploads` ข้อมูลทั้งหมดเป็นข้อมูลสมมติ

ผลทดสอบผ่านไม่ได้แปลว่าไม่มี bug: ชุดเดิมยังขาดกรณีที่ระบุด้านล่าง การอ่านโค้ดรอบนี้เป็นการตรวจระดับโมดูลและจุดเสี่ยง ไม่ใช่การตรวจทุกบรรทัดหรือทุกสถานะของ UI และไม่ได้เปรียบเทียบภาพ Canvas ใหม่ทุกหน้า ไม่รวมงานที่ยังไม่เสร็จ เช่น A15 ซึ่งมีการแก้ไฟล์พร้อมกับรอบตรวจนี้

## ลำดับแก้ไข

| ID | ระดับ | Task / Lane | ปัญหา | กรณียืนยัน |
|---|---|---|---|---|
| BUG-01 | P1 | A27 / Git | ผูก GitHub installation ขององค์กรอื่นได้โดยใช้ state ของตัวเอง | R08 |
| BUG-02 | P1 | A17 / Realtime | JSON `null` และ cookie ผิดรูปแบบทำให้ Promise reject โดยไม่มีตัวรับ | R02, R14 |
| BUG-03 | P1 | A28 / Auth | บัญชีที่ถูกปิดยังเรียก API ด้วย Bearer token ได้ | R01 |
| BUG-04 | P1 | A12 / QA | Guest Viewer เห็นชื่อผู้ทดสอบและข้อมูล Bug ที่ต้องซ่อน | R05 |
| BUG-05 | P1 | A25 / Channels | แจ้งเตือนที่ค้างส่งยังถูกส่งหลังถอนสิทธิ์ผู้รับ | R11 |
| BUG-06 | P1 | A11 / Files | PUT URL เดิมเขียนทับเนื้อหาเวอร์ชันที่บันทึกแล้วได้ | R03 |
| BUG-07 | P2 | A11 / Files | uploadToken เดียวสร้างหลายไฟล์/หลายเวอร์ชันได้ | R03 |
| BUG-08 | P2 | A11 + A29 | ตรวจพื้นที่เฉพาะตอนออก URL ทำให้ยืนยันไฟล์เกินโควตาได้ | R04 |
| BUG-09 | P2 | A07/A09/A11/A21/A22/A27 | บล็อก Guest Member เหมารวมกับ Guest Viewer | R06 + อ่านโค้ด |
| BUG-10 | P2 | A04 + A05 | สร้างโปรเจกต์แล้วไม่ใส่กฎ Workflow ค่าเริ่มต้น | R09 |
| BUG-11 | P2 | A07 / Gantt | pagination ประวัติแก้แผนทำรายการหายเมื่อเวลาเท่ากัน | R10 |
| BUG-12 | P2 | A29 + A30 | ราคารายปีไม่ใช้ราคาต่อเดือนที่ตั้งใหม่ | R07 |
| BUG-13 | P2 | A23 + A25 | ปิด In-app แล้ว Email ที่เปิดไว้หยุดส่งไปด้วย | R12 |
| BUG-14 | P2 | A27 / Git | sync repository อ่านแค่หน้าแรก และลบ repository นอกหน้านั้น | R13 + อ่าน syncRepos |

P1 = เสี่ยงสิทธิ์/ข้อมูลรั่ว/ข้อมูลเปลี่ยนย้อนหลัง/กระทบโปรเซส API ควรแก้ก่อนใช้งานจริง ส่วน P2 = พฤติกรรมและข้อมูลทางธุรกิจผิดที่ควรแก้ก่อนปิดงาน

## รายละเอียดสำหรับแก้ไข

### BUG-01 — GitHub setup ไม่พิสูจน์สิทธิ์ของผู้ติดตั้งต่อ installation

- จุดผิด: `apps/api/src/git/git.service.ts:67–80`, `apps/api/src/git/git.controller.ts` (`GET hooks/github/setup`), `apps/api/src/git/github-api.ts:44`.
- `state` พิสูจน์แค่ Workspace และผู้ใช้ที่เป็น Admin แต่ `installation_id` รับจาก query แล้วใช้ App credential อ่านการติดตั้งและ repository ทันที ไม่มี GitHub user authorization มาพิสูจน์ว่าคนนี้เข้าถึง installation นั้นได้
- เงื่อนไข: installation ของ App มีอยู่จริง และยังไม่ถูกผูกกับ Workspace อื่นใน Friday (`installation_taken` ป้องกันเฉพาะที่ผูกไปแล้ว)
- ทำซ้ำ: Admin ขอ `install-url` ของ Workspace ตัวเอง → นำ state นั้นไปเรียก setup โดยใส่ ID ของ installation อื่น → ระบบผูกองค์กร/repository อื่นเข้ากับ Workspace ผู้เรียก R08 จำลอง GitHub API และยืนยันว่าได้รับ repository `other-org/private-repo`
- ผลกระทบ: ผู้ไม่เกี่ยวข้องอาจผูก private repository ขององค์กรอื่น และรับข้อมูล Commit/PR ผ่าน integration ได้
- แนวแก้: เพิ่มขั้นยืนยันตัวตน GitHub ของผู้ติดตั้งและตรวจสิทธิ์ต่อ installation ก่อน bind อย่าใช้เพียง App JWT และ state ที่ผู้ใช้ขอเอง; nonce ใช้ครั้งเดียวและผูกกับ flow ที่ตรวจสิทธิ์แล้ว
- เกณฑ์ผ่าน: state ถูกต้องแต่ผู้ใช้ไม่มีสิทธิ์ต่อ installation ต้องถูกปฏิเสธและไม่มีการบันทึก installation/repository; ผู้มีสิทธิ์ยังติดตั้งได้ตามปกติ

### BUG-02 — Realtime ปล่อย unhandled rejection จาก input ของ client

- จุดผิด: `apps/api/src/realtime/realtime.service.ts:61`, `:112`, `:121–125`, `:149–157`.
- `JSON.parse('null')` สำเร็จ แต่ `m.id` โยน TypeError อยู่นอก try/catch และ listener เรียก `void this.message(...)` โดยไม่มี catch
- handshake ที่ส่ง `Cookie: fm_session=%` ทำให้ `decodeURIComponent(cookie)` โยน URIError ก่อนเข้า `.catch()` ของ `sessions.find`; `onUpgrade` ก็ทิ้ง Promise โดยไม่มี catch เช่นกัน
- ทำซ้ำ: R02 เรียก message handler ด้วย `null` และพบ rejected TypeError; R14 เรียก upgrade ด้วย cookie ดังกล่าวและพบ rejected URIError โดยกรณี cookie ไม่ต้องมี session ที่ถูกต้อง
- ผลกระทบ: ไม่ตอบ error ตาม protocol และเสี่ยงทำให้โปรเซส API จบจาก unhandled rejection ตามนโยบาย runtime
- แนวแก้: ตรวจ JSON ด้วย schema ว่าเป็น object ที่อนุญาต, ครอบ decode cookie, รับ rejection ที่ entry point ทุกแห่ง รวมถึง async timer ของ poll/recheck และปิด socket/ตอบ error อย่างควบคุมได้
- เกณฑ์ผ่าน: ทดสอบผ่าน WebSocket จริงใน child process ด้วย `null`, array, scalar, malformed cookie และ DB error; โปรเซสยังอยู่ ไม่มี unhandled rejection และ client ปกติยังใช้ได้

### BUG-03 — API token ของบัญชีที่ disabled ยังใช้ได้

- จุดผิด: `apps/api/src/auth/api-tokens.ts:33–41`.
- `findApiToken` ตรวจสมาชิก active, Workspace ที่ยังไม่ลบ และ token ที่ยังไม่ revoke แต่ไม่ join `users` เพื่อตรวจ `disabled_at` ต่างจาก session authentication
- ทำซ้ำ: สร้าง token → ตั้ง `users.disabled_at = now()` โดยสมาชิก Workspace ยัง active → ใช้ Bearer token GET โปรเจกต์ → ได้ **200** (R01)
- แนวแก้: ตรวจบัญชีผู้สร้าง token ว่ายังเปิดใช้งานทุกคำขอ เช่น join `users` และ `isNull(disabledAt)` ให้เทียบเท่า session auth
- เกณฑ์ผ่าน: token ของ disabled user ได้ 401 ใช้กับทั้ง read/write; token ของบัญชีปกติยังใช้ได้; ไม่สับสนกับการ deactivated เฉพาะ Workspace

### BUG-04 — QA response รั่วข้อมูลถึง Guest Viewer

- จุดผิด: `apps/api/src/qa/qa.service.ts:63–89`.
- `listRuns` ใช้ `loadIssue` ซึ่งอนุญาต Guest Viewer เปิดงานที่แชร์ แต่ส่ง `runDto` เต็ม ทั้ง `tester` และ `bugs` โดยไม่ตัดข้อมูล Guest
- ทำซ้ำ: แชร์ Task ให้ Guest Viewer → บันทึกผล failed โดยคนในทีม → สร้าง Bug จากผลนั้นโดย Bug ไม่แชร์ → Guest เรียก `GET w/{ws}/issues/{key}/test-runs` → ได้ 200 พร้อม `tester.displayName = Mick` และ key/title ของ Bug ที่ซ่อน (R05)
- ผิดกฎ: `docs/spec/04-permissions.md` ข้อ 4 ห้าม Guest Viewer เห็นชื่อคนและ Bug
- แนวแก้: กำหนดสิทธิ์อ่านผลทดสอบให้ชัด ถ้าอนุญาตต้องใช้ serializer Guest ตัด tester identity, Bug และหลักฐานที่ไม่มีสิทธิ์ ห้ามพึ่ง UI ซ่อน
- เกณฑ์ผ่าน: Guest Viewer ไม่ได้ชื่อ/UUID ของผู้ทดสอบหรือ Bug ที่ซ่อน ทั้ง response หลัก/ล่าสุด/ไฟล์แนบ; Guest Member ยังทำงานตามสิทธิ์ Member

### BUG-05 — ส่งแจ้งเตือนค้างไปยังผู้ถูกถอนสิทธิ์

- จุดผิด: `apps/api/src/channels/dispatcher.ts:229–256` และ personal senders ใน `senders.ts`, `line/line.sender.ts`.
- ตรวจ audience ตอนสร้าง notification แต่ `deliver()` อ่าน notification เดิมแล้วส่งทันที ไม่ตรวจสมาชิก active, บัญชี disabled, สิทธิ์โปรเจกต์/งาน หรือ pref ที่เปลี่ยนไปหลังเข้าคิว
- ทำซ้ำ: สร้าง notification + pending delivery ให้ Dev → deactivated สมาชิก Workspace → เรียก deliver ในเวลาที่ไม่ติด quiet hours → mock Email sender ยังถูกเรียกหนึ่งครั้ง (R11)
- ผลกระทบ: Email/LINE ที่เลื่อนจาก quiet hours หรือ retry อาจส่งข้อมูลให้คนที่หมดสิทธิ์แล้ว โดยเฉพาะเมื่อ Safe mode ปิด
- แนวแก้: ตรวจสิทธิ์ผู้รับและการตั้งค่าล่าสุดก่อนส่ง personal delivery ทุกครั้ง; แยกนโยบาย project webhook/group ออกจากผู้รับรายคน และบันทึกเหตุผลเมื่อยกเลิกส่ง ห้าม retry รายการที่สิทธิ์ถูกถอน
- เกณฑ์ผ่าน: deactivated/disabled/ออกจาก private project/งานยกเลิกแชร์/ปิด pref ระหว่างรอคิว ต้องไม่ส่ง; ผู้รับที่ยังมีสิทธิ์ส่งได้

### BUG-06 — URL อัปโหลดเดิมแก้เนื้อหาไฟล์เวอร์ชันเก่าได้

- จุดผิด: `apps/api/src/files/storage.ts:65–94`, `files.service.ts:97–106` และ `storage.controller.ts`.
- upload URL ใช้ซ้ำได้ตลอด TTL และ LocalStorage ลงท้ายด้วย `rename(tmp, path)` ทับ storage key เดิม แม้ key นั้นถูกอ้างใน file_versions แล้ว ไม่มีเงื่อนไข write-once หรือย้ายจาก staging ไป immutable object หลัง commit
- ทำซ้ำ: ขอ URL สำหรับ 3 bytes → PUT `old` → POST files ยืนยัน → PUT `NEW` ไป URL เดิม → ดาวน์โหลดเวอร์ชันที่บันทึกแล้วได้ `NEW` โดยไม่มีเวอร์ชันใหม่หรือ audit การแก้เนื้อหา (R03)
- ผลกระทบ: หลักฐาน QA/Bug และประวัติเวอร์ชันเปลี่ยนย้อนหลังได้
- แนวแก้: แยก staging key กับ committed key; หลังยืนยันย้าย/คัดลอกเข้า key ใหม่ที่ client ไม่มีสิทธิ์ PUT หรือตรึง object version/checksum ให้แน่นอน ครอบคลุมทั้ง Local และ S3 ที่รับ PUT ซ้ำได้
- เกณฑ์ผ่าน: URL เดิมอัปโหลดซ้ำแล้วเนื้อหาเวอร์ชันที่ยืนยันต้องไม่เปลี่ยน; แก้ไฟล์ต้องสร้าง version ใหม่เท่านั้น; เพิ่ม race test PUT ระหว่าง finalize

### BUG-07 — uploadToken ไม่ได้ใช้ครั้งเดียว

- จุดผิด: `apps/api/src/files/files.service.ts:111–150`, `:155–165`; schema `file_versions` ไม่มี unique storage key หรือ consumption record
- ทำซ้ำ: อัปโหลดครั้งเดียว → POST files ด้วย uploadToken เดิมสองครั้ง → ได้ 201 ทั้งคู่และ file ID คนละตัว แต่ใช้ storage key เดียวกัน (R03) เส้นทาง createVersion ก็ไม่มีการ consume token เช่นกัน
- ผลกระทบ: เกิดไฟล์/เวอร์ชันซ้ำ, usage ถูกนับซ้ำ, หลายไฟล์แชร์ object ที่ยังแก้ทับได้จาก BUG-06
- แนวแก้: consume upload อย่าง atomic ในธุรกรรม finalize โดย request ซ้ำคืนผลเดิมแบบ idempotent หรือ error ที่ชัดเจน รวม concurrent requests
- เกณฑ์ผ่าน: finalize upload เดียวพร้อมกันสองคำขอได้ file/version เพียงรายการเดียว และคิดพื้นที่เพียงครั้งเดียว

### BUG-08 — ยืนยัน upload ที่เกินพื้นที่แพ็กเกจได้

- จุดผิด: `apps/api/src/files/files.service.ts:101` เทียบกับ `create()` / `createVersion()`.
- ตรวจ PlanLimits ตอนขอ upload URL แต่ไม่ reserve พื้นที่และไม่ตรวจซ้ำตอน finalize URL หลายอันจึงผ่านจาก usage เดียวกันก่อนมีการบันทึก
- ทำซ้ำ: ขอ URL ขณะพื้นที่ว่าง → ทำ usage ให้เต็ม → ขอ URL ใหม่ได้ 402 แต่ POST files ยืนยันด้วย token ก่อนหน้ายังได้ **201** (R04 ใช้ metadata ในฐานทดสอบ ไม่สร้างไฟล์ขนาดใหญ่จริง)
- แนวแก้: ล็อก/reserve โควตาต่อ Workspace และตรวจพื้นที่ในธุรกรรม finalize ทั้งไฟล์ใหม่และ version; ห้ามแก้แค่เพิ่ม assert ที่ยัง race ได้
- เกณฑ์ผ่าน: เมื่อเหลือพื้นที่สำหรับไฟล์เดียว การ finalize สองไฟล์พร้อมกันสำเร็จได้ไม่เกินหนึ่ง และอีกคำขอได้ 402; token ซ้ำไม่นับเพิ่ม

### BUG-09 — Guest Member ถูกปฏิเสธทั้งที่มีสิทธิ์ของ Member

- จุดผิด: เงื่อนไข `access.guestViewer || tenant.role === 'guest'` ใน `files/files.service.ts:86`, `calendar/calendar.service.ts:62`, `gantt/gantt.service.ts:104`, `reports/insights.service.ts:45`, `search/saved.service.ts:90`, `git/git.service.ts:178` รวมถึง Auto-schedule `gantt.service.ts:330`.
- ทำซ้ำ: ผู้ใช้ Workspace role = guest แต่ Project role = member → my-permissions มี `file.upload` → GET files กลับ 403 `guest_view_limited` (R06)
- ผิดกฎ: ตารางข้อ 4 ของ `04-permissions.md` แยก Guest Member ซึ่งเห็นทุกหน้าในโปรเจกต์, Bug, Workload/Reports ของโปรเจกต์ และไฟล์ตาม L2 ออกจาก Guest Viewer
- แนวแก้: ใช้ `guestViewer`/สิทธิ์จริงตาม endpoint; เก็บข้อห้าม Settings/Audit, รายชื่อทั้งองค์กรและ Workload รวมไว้สำหรับ Guest ทุกแบบ อย่าลบเงื่อนไข guest เหมารวมทั้ง repo
- เกณฑ์ผ่าน: เพิ่ม matrix Workspace guest × Project viewer/member ครอบคลุม endpoints ข้างต้น และตรวจว่า Settings/รายชื่อคนทั้งองค์กรยังถูกปฏิเสธ

### BUG-10 — โปรเจกต์ใหม่ไม่มี default Workflow rules

- จุดผิด: `apps/api/src/projects/projects.service.ts:331–342` เทียบกับ `project-structure/rules.ts` ฟังก์ชัน `defaultWorkflowRules()`.
- สร้าง Workflow และสถานะแล้ว แต่ไม่ insert workflow_rules ค่า default บางกฎมี `implicitEnabled=false` จึงไม่ได้ทำงาน เช่น reviewer_required และ fix_reference_required
- ทำซ้ำ: สร้างโปรเจกต์ใหม่ → query workflow_rules ได้ 0 แถว → Task ไม่มี Reviewer ย้ายไป Review ผ่าน **200** (R09)
- ปัญหานี้มีบันทึกคำขอนอก lane ใน A04 แล้ว แต่ A05 merge แล้วและยังไม่ได้เชื่อม
- แนวแก้: seed default ของ Standard/Bug ภายในธุรกรรมสร้างโปรเจกต์เดียวกัน ครอบคลุม Template/Wizard/Sample และวางวิธีดูแลโปรเจกต์เดิมโดยไม่ทับกฎที่ผู้ใช้ตั้งเอง
- เกณฑ์ผ่าน: โปรเจกต์ใหม่มีกฎตรง catalog; Review ไม่มี Reviewer ถูก 422; Fixed ไม่มีหลักฐานถูก 422; การปิดกฎเองยังมีผล

### BUG-11 — ประวัติแก้แผนหายข้ามหน้า

- จุดผิด: `apps/api/src/gantt/gantt.service.ts:239–277`.
- เรียง `(changed_at DESC, id DESC)` แต่ cursor ส่งเฉพาะเวลาที่ถูกแปลงเป็น JS Date ความละเอียดมิลลิวินาที และหน้าถัดไปใช้ `changed_at < before` รายการที่ timestamp เดียวกันจึงหาย อีกทั้งความละเอียด microsecond ของ PostgreSQL ถูกตัดทิ้ง
- ทำซ้ำ: insert plan_changes 3 แถวเวลา `2026-11-06 01:02:03.123456+00` → GET limit=1 ได้ nextCursor → GET before=cursor ได้ 0 แถว ทั้งที่เหลือ 2 (R10)
- แนวแก้: cursor บรรจุเวลาเต็มจาก PostgreSQL + UUID และใช้ tuple comparison `(changed_at,id) < (...)` เช่นแนวที่ comments/activity ใช้อยู่
- เกณฑ์ผ่าน: อ่านทีละหน้าได้ครบทุก ID ไม่ซ้ำไม่หาย แม้เวลาทุกแถวเท่ากันหรืออยู่ใน millisecond เดียวกัน; cursor ผิดรูปแบบต้องได้ 400

### BUG-12 — ราคาปีไม่อิง override ราคาต่อเดือน

- จุดผิด: `apps/api/src/billing/catalog.ts:55–60` ใช้ร่วมกับ Billing quote และ Public plans
- เมื่อ `override.yearly` ว่าง สูตรรายปีคูณ `spec.monthlySatang` แทนราคาที่ override ไว้ใน `plans.price_monthly_satang`
- ทำซ้ำ: Team S ตั้ง monthly=200000 สตางค์ (2,000 บาท), yearly=null → เดือนตอบ 200000 แต่ปีตอบ **1500000** (15,000 บาท) แทน 2000000 ตามสูตร 10 เดือน (R07)
- แนวแก้: ให้ yearly override มาก่อน; ถ้าไม่มีให้ใช้ `(monthly override ?? catalog monthly) × YEARLY_MONTHS` และจัดการราคา 0 อย่างตั้งใจ
- เกณฑ์ผ่าน: public plans และ billing quote ได้ราคาเดียวกันทั้งเดือน/ปี รวมกรณี override เฉพาะ monthly, เฉพาะ yearly, ทั้งคู่ และไม่มี override

### BUG-13 — In-app toggle ไปปิด Email ด้วย

- จุดผิด: `apps/api/src/notifications/fanout.ts:87–100` และ `channels/dispatcher.ts` ซึ่งเริ่มท่อจาก notifications เท่านั้น
- เมื่อปิด In-app ของ event ที่ไม่ล็อก ระบบตัดผู้รับก่อนสร้าง notification ทำให้ Email/LINE และกฎ Webhook ที่อาศัย notification เหล่านั้นไม่มีข้อมูลให้ dispatch แม้ตั้งช่องทางภายนอกให้ enabled
- ทำซ้ำ: Dev Watch งาน → ตั้ง `issue.commented/in_app=false` และ `issue.commented/email=true` → publish issue.commented โดยคนอื่น → ไม่มี notification ใหม่และ mock Email ไม่ถูกเรียก (R12; sender available และ target พร้อม)
- แนวแก้: แยกการตัดสิน In-app ออกจาก external delivery fanout จะเก็บ event/delivery envelope แยกหรือ dispatch จาก domain event โดยตรงก็ได้ แต่ห้ามบังคับเปิด Inbox เพื่อรับ Email
- เกณฑ์ผ่าน: In-app=false/Email=true ยังส่ง Email, In-app=true/Email=false เข้า Inbox อย่างเดียว; ตรวจ LINE และ project webhook เมื่อทุกผู้รับปิด In-app ด้วย

### BUG-14 — Git repositories หายเมื่อเกิน 100 รายการ

- จุดผิด: `apps/api/src/git/github-api.ts:50–54` และ `git/git.service.ts:85–94`.
- เรียก `/installation/repositories?per_page=100` ครั้งเดียว ไม่ตามหน้าถัดไป แล้ว syncRepos ถือว่ารายการที่ไม่อยู่ในชุดนั้นถูกถอดสิทธิ์และ DELETE ทิ้ง
- ทำซ้ำ: R13 จำลองหน้าแรก 100 repo พร้อม Link rel=next → client เรียก list เพียงครั้งเดียวและคืน 100 repo; จากโค้ด sync รายการเดิมในหน้าที่ 2 จะถูกจัดเป็น gone และลบ รวม project links ที่ cascade
- แนวแก้: ดึงครบทุกหน้าก่อนคำนวณ diff และทำ deletion หลังดึงสำเร็จครบเท่านั้น; ระวัง failure ระหว่างหน้าไม่ให้กลายเป็นการลบข้อมูล
- เกณฑ์ผ่าน: fixture 101+ repo ต้องเก็บครบและคง project link ของ repo หน้าถัดไป; หน้า 2 ล้มเหลวต้องไม่ลบของเดิม

## หลักฐานและวิธีตรวจซ้ำ

ไฟล์ประกอบในโฟลเดอร์นี้:

- `claude-review-repro.e2e.test.ts.txt` — source ของกรณี R01–R14 ต้องคัดลอกไป `apps/api/test/codex-review.e2e.test.ts` ก่อนรัน เพราะใช้ relative imports ของ API tests
- `baseline-tests.log` — ผล suite เดิม
- `focused-repro.log` — ผลกรณีเพิ่มเติมรอบสุดท้าย
- `build-attempt.log` — log ของ build ที่หยุดไว้ ไม่ใช่หลักฐานว่า build ผ่านหรือมี compile error

**สคริปต์นี้ใช้ startApp() ซึ่งล้างฐานข้อมูลที่ระบุ ต้องใช้ฐาน review แยกเท่านั้น ห้ามชี้ฐานพัฒนาที่มีข้อมูลต้องเก็บ** ทดสอบ sequential กับไฟล์อื่นที่ใช้ฐานเดียวกัน

```sh
cp docs/reviews/claude-review-repro.e2e.test.ts.txt apps/api/test/codex-review.e2e.test.ts
DATABASE_OWNER_URL=postgres://friday_owner:friday_owner_dev@localhost:54329/friday_codex_review_20261106 \
DATABASE_APP_URL=postgres://friday_api:friday_api_dev@localhost:54329/friday_codex_review_20261106 \
DATABASE_SYSTEM_URL=postgres://friday_worker:friday_worker_dev@localhost:54329/friday_codex_review_20261106 \
UPLOAD_DIR=/private/tmp/friday-codex-review-uploads \
pnpm --filter @friday/api test test/codex-review.e2e.test.ts
```

ฐานต้อง migrate และมี dev roles พร้อมก่อนรัน ไม่ต้องใช้ GitHub/LINE/SMTP จริง ใช้ mocks ภายในสคริปต์ หลังใช้ให้นำไฟล์ชั่วคราวใน apps/api/test ออก ส่วนไฟล์หลักฐานใน docs เก็บไว้ได้

Assertions ของสคริปต์ตั้งใจตรวจ **พฤติกรรมผิดปัจจุบัน** ดังนั้น “14 passed” หมายถึงทำซ้ำ bug ได้ หลังแก้แต่ละข้อ ให้เปลี่ยนเป็น assertions ของพฤติกรรมที่ถูกต้องตามเกณฑ์ผ่าน และนำ regression tests ไปวางใน lane ของงานนั้น ไม่ควรใช้สคริปต์นี้เป็น acceptance suite ทั้งก้อน

## ตารางขอบเขตงานที่ตรวจ

| กลุ่มงานที่เสร็จ | สิ่งที่ตรวจ | รายการที่พบ |
|---|---|---|
| T00 | schema, tenant/RLS helpers, constraint ที่เกี่ยวข้อง และ DB suite | ไม่เปิด bug แยกในรอบนี้ |
| T01 | CI workflow, scripts ตั้งฐาน และผล typecheck/test | ไม่เปิด bug แยกในรอบนี้ |
| W00, W01, W02, W06 | API client, auth navigation/login, query scope, Drawer และ Kanban, Web suite | ไม่เปิด bug เฉพาะหน้าเว็บในรอบนี้ |
| A01, A02, A03 | comments/mentions/activity, dependency/checklist, issue permissions/lifecycle และ API suite | ไม่เปิด bug แยกในรอบนี้ |
| A04, A05 | สร้างโปรเจกต์/Workflow, calendar changes และ permission catalog | BUG-10 |
| A06 | Sprint metrics, capacity/leaf calculation และ API suite | ไม่เปิด bug แยกในรอบนี้ |
| A07 | CPM, auto-schedule, Baseline และ history pagination | BUG-09, BUG-11 |
| A08, A09, A10 | Workload/รายงาน/Home scope, การกรอง Guest และ API suite | BUG-09 ใน Reports/Insights |
| A11 | storage, upload/finalize, evidence, quota และสิทธิ์ไฟล์ | BUG-06–09 |
| A12 | Test runs, create Bug, time logs และ Guest serializer | BUG-04 |
| A13, A28 | session/auth/MFA/token, guard และ API suite | BUG-03 |
| A14 | สมาชิก/คำขอเข้าร่วม, deactivation และ API suite | ใช้ยืนยันสถานะถอนสิทธิ์ใน BUG-05 |
| A16, A17 | queue, retry, websocket input/auth/events และ API suite | BUG-02 |
| A20, A21, A22 | Profile/preferences/leaves, Calendar/iCal, search/saved views | BUG-09 และการเชื่อม pref ใน BUG-13 |
| A23, A24, A25 | audience, fanout, channel preference/quiet/retry, LINE sender | BUG-05, BUG-13 |
| A27 | installation setup, App API, sync และ Git endpoints | BUG-01, BUG-09, BUG-14 |
| A29, A30 | pricing, limits, public catalog/legal และ API suite | BUG-08, BUG-12 |

“ไม่เปิด bug แยก” หมายถึงยังไม่มีข้อที่ยืนยันพอจะส่งแก้ในรอบนี้ ไม่ใช่การรับรองว่าโมดูลนั้นไม่มีปัญหา

## แนวทางส่งงานให้ Claude

1. เริ่ม BUG-01–06 แล้วจึง P2 จัด branch ตาม lane เดิม และเขียนคำขอนอก lane สำหรับการแก้ร่วมโมดูล/DB ที่จำเป็น
2. ทำ regression test ตามเกณฑ์ผ่านก่อนปิดแต่ละรายการ โดยทดสอบ Guest Member และ Guest Viewer แยกกันเสมอ
3. รัน typecheck และ suite ที่เกี่ยวข้อง แล้วรันชุดรวมบนฐานทดสอบแยกก่อนรวมงาน
4. บันทึก commit/ผล test/สถานะแก้ของแต่ละ BUG ในเอกสารนี้หรือเอกสารติดตาม อย่าติ๊กแก้แล้วจากการเปลี่ยนโค้ดอย่างเดียว
5. ไม่รวมงาน A15 ที่กำลังแก้พร้อมกัน และไม่ทับไฟล์ที่เปลี่ยนอยู่ใน workspace
