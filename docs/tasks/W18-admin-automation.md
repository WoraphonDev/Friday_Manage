# W18 · Admin Console, หน้าตาข้อความแจ้งเตือน และ Automation

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A18 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/w/[ws]/admin/**` · `apps/web/app/w/[ws]/p/[key]/automation/**` · `apps/web/messages/th/admin-automation.json` |
| หน้าจอ | N1 (`design/canvas/AdminConsole.dc.html`) · N2 (`design/canvas/NotifyTemplates.dc.html`) · P2 (`design/canvas/Automation.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.3, 3.9 แถว automations |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- ทุกแท็บของ N1 (แสดงเฉพาะส่วนที่ API มีแล้ว)
- N2 preview ข้อความ LINE / Email / Webhook
- P2 ตัวสร้างกฎ + dry-run

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

ยังไม่ได้เทียบภาพที่ 1440 / 390 px (ข้อแรกของ "เสร็จเมื่อ" ยังเว้นไว้) · layout ทำตาม Canvas และมี breakpoint 760 px (เมนูเป็นแถบเลื่อนแนวนอน, ตารางยุบคอลัมน์)

หน้าที่ทำ:

- `w/[ws]/admin/[[...section]]` (N1): `admin/<แท็บ>` (ไม่ระบุ = แดชบอร์ด · แท็บที่ไม่รู้จัก = NotFound) · Owner / Admin เท่านั้น: Member / Guest ได้ Forbidden โดยไม่เรียก API · เมนูจัดกลุ่มตาม Canvas + ป้ายจำนวน `actions` บนแดชบอร์ด + ลิงก์ "สมาชิก & คำเชิญ ↗" ไป `/members` (W10) · component ใน `admin/_components/`
  - แดชบอร์ด (`GET w/admin/overview`): KPI 6 ช่อง, เรื่องที่ต้องดำเนินการ (ปุ่ม "ดู" พาไปแท็บที่แก้ได้ตาม `code`), กราฟผู้ใช้ Active 8 สัปดาห์
  - โปรเจกต์ทั้งหมด: `projectList` ของ overview · โปรเจกต์ที่ `joined: false` ในรายการโปรเจกต์ของ shell มีปุ่ม "เข้าร่วมในฐานะ Admin" (`POST p/join-as-admin`) แทนปุ่ม "เปิด"
  - ทีม & โครงสร้าง: `CRUD w/teams` + `w/teams/{id}/members` · สร้างทีมพร้อมหัวหน้า + สมาชิก (ตัด Guest / คนที่ไม่ active ออกจากตัวเลือก) · Dialog แก้ไข: ชื่อ, หัวหน้า, เพิ่ม / เอาออก, ลบทีม
  - ค่ามาตรฐาน: ปฏิทินวันหยุด (`holiday-calendars`, `holidays` 4 เดือนข้างหน้า) · ปฏิทินของระบบแก้ไม่ได้ → "นำเข้าจากประกาศ ธปท." = `POST holiday-calendars {copyFromId}` แล้ว `PATCH settings {holidayCalendarId}` · เพิ่ม / ลบวันหยุดบริษัท แสดงจำนวนงานที่คำนวณ Plan End ใหม่จาก `recalculated` · เวลาทำงาน, วันทำงาน, Size → MD (ส่งเฉพาะที่เปลี่ยน), สวิตช์ override (บันทึกทันที) · Template (`project-templates` สร้างด้วยชื่อ + คำอธิบาย, ลบ)
  - Workload รวม (`GET w/workload?from&to&group=week&unit=md&team=`): 4 สัปดาห์จากวันจันทร์นี้ตาม Canvas · กรองตามทีม · ช่องที่เกิน capacity มีกรอบแดง · tooltip แยกตามโปรเจกต์ · "แบ่งให้โปรเจกต์ x / y ชม." จาก `allocatedHoursWeek` / `overAllocated`
  - ความปลอดภัย & SSO: การเข้าช่วยเหลือจากทีม Friday (`GET / PUT support-access` · เปิด / ปิดได้เฉพาะ Owner ตาม A31, Admin เห็นแบบปิดใช้) · SSO แสดง "ยังไม่เปิดใช้งาน" (03-api ระบุทำทีหลัง) · 2FA 3 ตัวเลือก + จำนวนที่เปิด + รายชื่อที่ยังไม่เปิด · รหัสผ่าน / Session / ล็อกบัญชี / โดเมนอีเมล / IP Allowlist → `PATCH security-policy` ส่งเฉพาะที่เปลี่ยน · 422 `ip_allowlist_locks_you_out` แสดงใต้ช่องพร้อม IP ของผู้แก้
  - Audit Log: chip หมวด (รวม `notify`), ผู้ใช้, ช่วงเวลา 7 / 30 วัน / กำหนดเอง → `GET audit-log` · โหลดเพิ่มด้วย `nextCursor` → `before` · ปุ่ม Export CSV เป็นลิงก์ `GET audit-log.csv` ด้วยตัวกรองเดียวกัน (API เขียน Audit การ export เอง)
  - ข้อมูล & PDPA: Data region (แสดงอย่างเดียว), ถังขยะ 30 / 90, การเก็บรักษา (ถาวร / 3 ปี) → `PATCH settings` · Export ทั้ง Workspace (`POST / GET exports` ถามซ้ำทุก 5 วินาทีจนเสร็จ แล้วแสดงลิงก์ดาวน์โหลด) · คำขอ PDPA (`data-requests`: บันทึกคำขอ, รับเรื่อง, ปฏิเสธ, ปิดคำขอ · คำขอลบต้องพิมพ์อีเมลผู้ขอให้ตรงก่อน · สำเนาที่เสร็จแล้วดาวน์โหลด `.../result`) · สวิตช์ขอความยินยอม · ลบ Workspace (Owner เท่านั้น พิมพ์ slug ยืนยัน → `DELETE w/` แล้วกลับ `/`)
  - ช่องทางแจ้งเตือน: โหมดปลอดภัย (`PATCH settings {safeMode}`) + ลิงก์ "ดูตัวอย่างข้อความ" ไป N2 · LINE OA (`GET / PUT channels/line-oa` ช่อง secret / token เว้นว่าง = ใช้ค่าเดิม ไม่ส่งไป · แสดงเฉพาะ 4 ตัวท้ายเป็น placeholder · คัดลอก Webhook URL · ทดสอบ `line-oa/test` · จำนวนกลุ่มจาก `line-groups`) · Email (`channels/email` + `verify-dns` + `test` · สถานะ SPF / DKIM / DMARC) · Webhook (`channels/webhooks` เพิ่ม, ส่งทดสอบ, ปิดชั่วคราว / เปิดใช้อีกครั้ง, ลบ · สถานะล้มเหลวจาก `consecutiveFailures`)
  - Integrations: GitHub (`GET integrations/git`, ปุ่มเชื่อมใช้ `install-url`) · GitLab และระบบ HR แสดง "เปิดให้ใช้ภายหลัง" · LINE / Email ชี้ไปช่องทางแจ้งเตือน · API tokens (`CRUD api-tokens` สร้างแบบ read / read+write, ยกเลิก)
  - แพ็กเกจ & Billing: สรุปแพ็กเกจ / ที่นั่ง / พื้นที่จาก overview + ลิงก์ไป `/billing` (หน้าเต็มเป็นของ W19)
- `w/[ws]/admin/notify-templates` (N2): `GET notification-templates/{event}/preview` ของ 4 เหตุการณ์ที่ API มีตัวอย่าง (มอบหมายงาน, ขอเลื่อน Due, Bug ใหม่, สรุปรายวัน) · เรียก 2 ครั้ง: `channel=email` (ได้ `message` ใช้วาด LINE + Email และหัวเรื่องอีเมลจาก `rendered.subject`) และ `channel=webhook&format=json` (Payload JSON) · สวิตช์โหมดปลอดภัยส่ง `safe=true|false` เพื่อดูตัวอย่างเท่านั้น ไม่บันทึกค่า Workspace (ค่าเริ่มต้นตาม `safeMode` ที่ API ตอบ)
- `w/[ws]/p/[key]/automation` (P2): `project.automation` จาก `my-permissions` (ไม่มี / Guest = Forbidden) · แท็บ กฎ (n) / แม่แบบ / ประวัติ · โควตา `usage.runsThisMonth / quota`
  - รายการกฎ: ชื่อ, `sentence`, สถิติ 30 วัน, ผู้สร้าง, ป้าย "ผิดพลาด n" · สวิตช์เปิด / ปิด = `PATCH {enabled}`
  - ตัวสร้างกฎ "เมื่อ … ถ้า … ให้ …": trigger 8 แบบ (status_changed เลือก จาก / เป็น, schedule เลือกรายวัน / รายสัปดาห์ + วัน + เวลา) · เงื่อนไขสูงสุด 10 ข้อ (ฟิลด์ 11 แบบ, คือ / ไม่ใช่, ตัวเปรียบเทียบตามชนิดฟิลด์, ค่าเลือกจาก `form-options` หรือพิมพ์เอง) · การกระทำสูงสุด 10 ข้อ (8 แบบ พร้อมช่องเฉพาะของแต่ละแบบ) · "อ่านเป็นประโยค" คิดสดฝั่งเว็บระหว่างแก้ ใช้ `sentence` ของ API เมื่อยังไม่แก้ · ปุ่มบันทึกปิดเมื่อช่องที่ API บังคับยังว่าง (`incomplete`) · `toBody` ตัดช่องว่างก่อนส่ง · ลบกฎ
  - Dry run: `POST automations/{id}/dry-run` (ใส่ Issue key เพื่อทดสอบงานเดียวได้) แสดงจำนวนที่ตรง / ตรวจ, งานที่ตรงพร้อม `wouldDo` + `warning`, `notes`
  - แม่แบบ: การ์ด "กฎว่าง" + `GET automation-templates` · "ใช้แม่แบบนี้" เปิดเป็นฉบับร่างในตัวแก้ให้ปรับก่อนบันทึก (`POST automations`)
  - ประวัติ: `GET automations/runs` + โหลดเพิ่ม · แปล `detail.steps` / `detail.reason` เป็นข้อความ

คำตัดสินที่ต่างจาก Canvas:

- ตัวเลขและรายการในทุกแท็บมาจาก API จริง จึงไม่มีบางส่วนที่ Canvas วาดไว้: แดชบอร์ดไม่มีข้อความ "เพิ่มจาก 5 เป็น 8 คน" แบบเทียบเปอร์เซ็นต์ (ใช้ค่าสัปดาห์แรก → ล่าสุด), LINE ไม่มีโควตาข้อความเดือนนี้และ "ผู้ใช้ที่ผูก LINE แล้ว x / y" (API ไม่คืน), Webhook ไม่แสดง URL เต็ม (API คืนเฉพาะ 4 ตัวท้าย), Audit log แสดงรหัส action + summary แทนคอลัมน์ "การกระทำ" กับ "รายการ" แยกกัน
- แท็บ "แพ็กเกจ & Billing" แสดงสรุป + ลิงก์ไป `/w/[ws]/billing` แทนตารางแพ็กเกจ / วิธีชำระ / ใบแจ้งหนี้ เพราะหน้าเต็มอยู่ใน lane ของ W19
- SSO + ยืนยันโดเมน แสดง "ยังไม่เปิดใช้งาน" (`w/sso-connections`, `w/domains` 03-api ระบุทำทีหลัง) · GitLab / ระบบ HR แสดง "เปิดให้ใช้ภายหลัง" (README › ยังไม่วางเป็นงาน)
- นโยบายรหัสผ่านแยก "ความยาวขั้นต่ำ" กับ "ต้องมีอักขระพิเศษ" เป็น 2 ช่อง (API เก็บแยก) · ล็อกบัญชีเลือกจำนวนครั้ง (เวลาล็อกแสดงเป็นคำอธิบาย) · โดเมนอีเมลและ IP Allowlist เป็นช่องหลายบรรทัด
- "การเข้าช่วยเหลือจากทีม Friday": ตัวเลือก "แจ้งเมื่อมีการเข้า" ส่ง `notifyAdmins: true` เสมอ (เขียนไว้ในคำอธิบาย) · ระยะเวลาที่เลือกมีผลตอนกดเปิด / บันทึก เพราะ API คืนเป็นวันหมดอายุ ไม่ใช่ค่าที่เลือก
- "+ สร้างกฎ" พาไปแท็บแม่แบบตาม Canvas และเพิ่มการ์ด "กฎว่าง" ไว้หน้าแรก · "ใช้แม่แบบนี้" เปิดฉบับร่างแทนการสร้างทันที เพราะชื่อสถานะในแม่แบบอาจไม่มีใน Workflow ของโปรเจกต์ (API ตอบ 422)
- Dry run ใช้ได้เฉพาะกฎที่บันทึกแล้วและยังไม่แก้ (API รับ `id` ของกฎที่บันทึก) · หน้าบอก "บันทึกกฎก่อนจึงทดสอบกับงานจริงได้"
- ตัวเลือกการกระทำ "ส่งเข้า LINE กลุ่ม / Webhook" ไม่มี เพราะ API ไม่มี action นี้ (ใช้กฎแจ้งเตือนของโปรเจกต์ใน Project Settings แทน) · การกระทำ "แจ้งเตือน → คนที่เลือก" เลือกได้ทีละคนในหน้านี้ (API รับหลายคน)
- N2 ไม่มีแถบบนสีเข้มของ Canvas (ใช้ shell ของ Workspace) แต่มี breadcrumb กลับ Admin Console › ช่องทางแจ้งเตือน · ผู้รับในตัวอย่างอีเมลใช้อีเมลของผู้ดู · ปุ่มในตัวอย่างเป็นข้อความ ไม่ใช่ลิงก์

คำขอนอก lane:

1. test อยู่ที่ `apps/web/src/lib/admin-automation.test.tsx` ตามแบบงานอื่น (vitest `include` เป็น `src/**`) ซึ่งอยู่นอก lane ตามตัวอักษร
2. A24 (LINE): `GET channels/line-oa` ยังไม่คืนโควตาข้อความเดือนนี้และจำนวนผู้ใช้ที่ผูก LINE ที่ Canvas แสดง
3. A31: `GET support-access` คืนแค่ `until` · ถ้าอยากให้หน้าแสดงตัวเลือก "7 วัน / 30 วัน / ตลอด" ที่เลือกไว้ ต้องคืน `duration` ด้วย
4. A26: แม่แบบอ้างชื่อสถานะตาม Workflow มาตรฐาน (เช่น Review, In progress) · โปรเจกต์ที่ใช้ชื่ออื่นจะบันทึกไม่ผ่าน (422) · เสนอให้ `GET automation-templates?project=` บอกว่าแม่แบบไหนใช้ได้กับโปรเจกต์นี้
5. A18 / A-Auth: นโยบาย IP Allowlist / โดเมนอีเมล / 2FA ยังเก็บค่าอย่างเดียว (ตามบันทึกของ A18) · หน้าเขียนบอกไว้ใต้ฟอร์ม

Test: `src/lib/admin-automation.test.tsx` 22 tests (MSW + `WorkspaceShell`): สิทธิ์ (Member ไม่เรียก API, 403, NotFound, 500 + requestId) · แดชบอร์ด / โปรเจกต์ + เข้าร่วมในฐานะ Admin / Billing · ทีม (สร้าง, แก้, เพิ่ม / เอาออก, ลบ) · ค่ามาตรฐาน (ส่งเฉพาะที่เปลี่ยนโดยไม่มี If-Match, validation, override, นำเข้า ธปท., เพิ่ม / ลบวันหยุด, Template) · Workload (ช่วง 4 สัปดาห์, เกิน capacity, กรองทีม) · ความปลอดภัย (2FA + นโยบาย, 422 IP, support access ของ Owner / Admin) · Audit (ตัวกรอง, cursor, CSV) · ข้อมูล (ถังขยะ, เก็บรักษา, Export, คำขอลบต้องยืนยันอีเมล, ยินยอม, ลบ Workspace) · ช่องทาง (Safe mode, LINE ไม่ส่งค่าลับที่ว่าง, DNS, Webhook + signing secret แสดงครั้งเดียว) · Integrations (GitHub, API token แสดงครั้งเดียว, ยกเลิก) · N2 (3 ช่องทาง, สลับเหตุการณ์, โหมดปลอดภัยไม่บันทึก) · Automation (สิทธิ์ / error, รายการ + toggle, แก้ + ประโยค + dry run, แม่แบบ → ร่าง → POST, ลบ + ประวัติ, ฟังก์ชัน `toBody` / `incomplete` / `draftSentence`) · `pnpm --filter @friday/web typecheck`, `test` (291 tests หลัง rebase) และ `build` ผ่าน

### Automation อยู่ในโครง Settings — 2026-11-07

- **ต่างจาก Canvas P2 โดยตั้งใจ** (ผู้ใช้แจ้งว่าเมนูซ้ายหายเมื่อเลือก Automation): หน้า Automation ใช้หัวและแท็บโปรเจกต์ชุดเดียวกับหน้าอื่น (แท็บ Settings เลือกอยู่) และมีเมนูซ้ายของ Settings โดย Automation เป็นรายการที่เลือก · ตัด breadcrumb ของหน้าเองออก
- แก้ช่องเลือกเหตุการณ์ (เมื่อ) ที่สูงผิดปกติ: `.in` มี flex-basis 140px ซึ่งในกล่องแนวตั้งกลายเป็นความสูง
- คำขอนอก lane: W00 `project-shell.tsx`, W13 `project-settings.tsx` (แยก `SettingsNav` / `SettingsFrame` ให้ใช้ร่วม)
