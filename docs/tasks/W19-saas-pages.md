# W19 · Landing, ราคา, ชำระเงิน, เกินแพ็กเกจ, กฎหมาย + Cookie

| | |
|---|---|
| Wave | 1 · ขนานกันได้ |
| รอ merge | W00, A29, A30 |
| Lane (แก้ได้เฉพาะ) | `apps/web/app/(public)/**` · `apps/web/app/work/[ws]/billing/**` · `apps/web/src/features/plan-limits/**` · `apps/web/messages/th/saas-pages.json` |
| หน้าจอ | R1 (`design/canvas/Landing.dc.html`) · R2 (`design/canvas/Checkout.dc.html`) · Q2 (`design/canvas/PlanLimits.dc.html`) · R4 (`design/canvas/Legal.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) · 03-api › 3.10 |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Landing + ราคาเหมาตามขนาดทีม
- Checkout 3 วิธี + หัก ณ ที่จ่าย
- Dialog / แบนเนอร์ 7 สถานการณ์ของ Q2 (แทน Dialog ทั่วไปใน API client)
- หน้ากฎหมาย + Cookie consent

## เสร็จเมื่อ

- [x] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [x] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [x] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### หน้าที่เพิ่ม

| Route | ใช้ API | หมายเหตุ |
|---|---|---|
| `/` (R1 Landing) | `GET public/plans` | หัวเว็บ (ฟีเจอร์ / ราคา / FAQ, เข้าสู่ระบบ, ทดลองใช้ฟรี) · Hero + ภาพตัวอย่าง Kanban · ฟีเจอร์ 6 ข้อ · ส่วนราคา · FAQ 6 ข้อ (`<details>`) · ท้ายเว็บลิงก์กฎหมาย 4 ฉบับ + ปุ่ม "ตั้งค่าคุกกี้" |
| `/pricing` | `GET public/plans` | ส่วนราคาเดียวกับ Landing (เป็น h1) · รายเดือน / รายปี (ลด `12 − yearlyMonths` เดือน) · แถบ "ทีมคุณมีกี่คน" 1–60 เลือกแพ็กเกจแนะนำจาก `seatLimit` · การ์ด 5 แพ็กเกจ (สตางค์ → บาท) · ตารางเปรียบเทียบ (คน, โปรเจกต์, ✓/– จาก `features[]` · Automation / Audit log / SSO เป็นข้อความคงที่ตาม Canvas เพราะ API ไม่มี) |
| `/legal/[type]` (R4) | `GET public/legal/{type}?version=` | `terms` · `privacy` · `dpa` · `cookie` · `subprocessors` (ชนิดอื่น = 404 ของ Next) · แท็บเป็นลิงก์ (`aria-current`) · เนื้อหา Markdown (`react-markdown` + GFM ที่มีอยู่แล้ว) · สารบัญจากหัวข้อ `##` · เวอร์ชัน / วันที่มีผล / ประวัติการแก้ไข (เลือกฉบับเก่า → `?version=`) · **ยังไม่มีเอกสาร (404 ของ A30)** = แถบแจ้ง "เอกสารฉบับจริงยังไม่เผยแพร่" + โครงหัวข้อตาม Canvas (ผู้ให้บริการช่วงเป็นตาราง ผู้ให้บริการ "รอประกาศ") |
| Cookie consent (`(public)/layout.tsx`) | — เก็บใน `localStorage` คีย์ `fm_cookie_consent` ตาม 03-api | ปฏิเสธที่ไม่จำเป็น / ตั้งค่า (จำเป็น-ปิดไม่ได้, วิเคราะห์, การตลาด) / ยอมรับทั้งหมด ปุ่มหน้าตาเท่ากัน · มีเลขรูปแบบ `v` ถ้าเปลี่ยนหมวดให้เพิ่มเลขเพื่อถามใหม่ · เปิดใหม่ได้จากท้ายเว็บ · แสดงเฉพาะหน้าสาธารณะ (ในแอปใช้แค่คุกกี้จำเป็นตาม Canvas) |
| `/w/[ws]/billing/checkout?plan=&cycle=` (R2) | `GET public/plans` · `GET w/usage` · `GET/PUT w/billing/profile` · `GET w/billing/quote` · `POST w/billing/checkout` (+ `Idempotency-Key`) · `GET w/billing/invoices/:id` (poll 3 วินาที) · `POST w/billing/invoices/:id/slip` | 1 แพ็กเกจ + รอบ (ไม่ระบุ = แพ็กเกจเล็กสุดที่รองรับทีม) · 2 ข้อมูลใบกำกับภาษี (นิติบุคคล / บุคคลธรรมดา, สาขา 5 หลัก, PO) กรอกค่าเดิมจาก profile, ตรวจก่อนส่ง และแสดง `details.fields` ของ 400 · 3 วิธีชำระ + หัก ณ ที่จ่าย 3% (นิติบุคคล + PromptPay/โอนเท่านั้น) · สรุปยอดจาก quote (หลังออกใบใช้ยอดของใบแจ้งหนี้) · **บัตร**: Stripe.js โหลดแบบ lazy จาก js.stripe.com เมื่อเลือกบัตร → `confirmCardPayment(client_secret)` → poll จน `paid` · **PromptPay**: QR จาก `promptpay.qrPayload` + นับถอยหลัง 15 นาที + ดาวน์โหลด SVG · "ฉันสแกนจ่ายแล้ว" ตรวจทันที · หมดอายุ = สร้าง QR ใหม่ · **โอน**: ออกใบแจ้งหนี้ → ธนาคาร / ชื่อบัญชี / เลขบัญชี / เลขอ้างอิง / ครบกำหนด + PDF ใบแจ้งหนี้ → แนบสลิป → "รอตรวจสลิป" · หน้าสำเร็จ 3 แบบตาม Canvas · **Idempotency-Key**: สร้างใหม่ต่อการกดชำระหนึ่งครั้ง, ใช้ซ้ำเมื่อ retry หลังเครือข่ายล้ม / 5xx, ล้างเมื่อได้ผล / 4xx / เปลี่ยนรายละเอียด |
| `/w/[ws]/billing` | `GET w/billing` · `GET w/usage` · `GET w/billing/invoices` · `POST invoices/:id/slip` · `POST invoices/:id/wht-certificate` · `POST w/billing/subscription/cancel` | แพ็กเกจ + สถานะ (ทดลอง / ใช้งาน / ค้างชำระ / ยกเลิก) + มิเตอร์สมาชิก / พื้นที่ / โปรเจกต์ · วิธีชำระ · ข้อมูลภาษี · ใบแจ้งหนี้ (PDF ใบแจ้งหนี้, ใบกำกับภาษี, แนบสลิป, อัปโหลด 50 ทวิ ก่อน `whtDueBy`) · ยกเลิกแพ็กเกจ (Owner เท่านั้น, ConfirmDialog) · `/billing/อื่น` = NotFound |
| `src/features/plan-limits` (Q2) | `GET w/usage` · `GET public/plans` · `GET/POST me/legal-acceptances` | `PlanLimitHost` / `PlanLimitDialog` (402 `plan_limit_reached` แยก `seats` / `projects` / `storage_bytes` + แบบทั่วไป: แท็ก, แถบ, ทางออก, ปุ่มเปลี่ยนเป็น `suggestedPlan`) · `UsageBanner` (ทีมเกินแพ็กเกจ, ทดลองใกล้หมด / หมดแล้ว, ค้างชำระ) · `FeatureLock` (ฟีเจอร์ Team บน Free) · `AutomationQuotaBanner` · `LegalUpdateBanner` (ข้อกำหนดเปลี่ยน · Owner/Admin รับทราบในนาม Workspace) · `WorkspaceBanners` รวมแบนเนอร์ให้ shell วางจุดเดียว · Member เห็น "ขอให้ Admin อัปเกรด" / "รับทราบ" แทนปุ่มซื้อ |

สิทธิ์: Billing / Checkout เปิดได้เฉพาะ Owner / Admin (`ws.billing`) · Member / Guest เห็น Forbidden โดยไม่เรียก API · API ตอบ 403 ก็แสดง Forbidden · ทุกหน้ามี Loading / Empty / Error พร้อม requestId

### ต่างจาก Canvas / สเปก และเหตุผล

- **สลับภาษา TH/EN ใน Landing ไม่ทำ** เป็นงาน W21
- **ข้อความ placeholder ของ Canvas** (`[ชื่อบริษัท]`, `[เลข 13 หลัก]`, `[Data region]`, `[อีเมล DPO]`, `[Payment gateway]`) ไม่แสดงบน production: บรรทัดผู้ขายท้ายเว็บแสดงเมื่อตั้ง `NEXT_PUBLIC_SELLER_NAME` / `NEXT_PUBLIC_SELLER_TAX_ID` · FAQ เรื่องที่เก็บข้อมูลเขียนใหม่โดยไม่ระบุภูมิภาค · บรรทัด DPO ชี้ไปที่ช่องทางในเอกสาร · ป้ายเหลือง "สำหรับ Prototype" แสดงเฉพาะตอนยังไม่มีเอกสารจริง
- **ปุ่มบนการ์ดราคา** ไปหน้าสมัคร `/signup?plan=&cycle=` แทน Checkout เพราะ Checkout ต้องมี Workspace · "ติดต่อฝ่ายขาย" ใช้ `NEXT_PUBLIC_SALES_URL` (ไม่ตั้ง = `/signup?plan=enterprise`)
- **Checkout อยู่ใน WorkspaceShell** (เส้นทาง `w/[ws]/billing/**`) จึงไม่มีหัวเว็บแยกแบบ Canvas · "ชำระเงิน · ชื่อ Workspace" และ "เชื่อมต่อแบบเข้ารหัส" ย้ายมาเป็นหัวของหน้า
- **บัตร**: ช่องบัตรเป็น Card Element ของ Stripe (iframe ช่องเดียว) แทน 4 ช่องใน Canvas เพื่อไม่ให้ข้อมูลบัตรผ่านเว็บของเรา · ไม่ได้ตั้ง `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` = แสดง "โหมดทดสอบ" แล้วรอสถานะจาก API · "ตัดอัตโนมัติทุกรอบ" เปลี่ยนเป็น "ชำระทันที" และหน้าสำเร็จเขียน "รอบถัดไปเริ่ม …" เพราะ A33 ยังไม่ตัดบัตรอัตโนมัติรอบถัดไป
- **PromptPay / โอนเป็น 2 จังหวะ**: QR / เลขบัญชีมาจากผลของ `POST checkout` จึงต้องกด "สร้าง QR PromptPay" / "ขอใบแจ้งหนี้และเลขบัญชี" ก่อน แล้วปุ่มจึงเปลี่ยนเป็น "ฉันสแกนจ่ายแล้ว" / "ส่งสลิปการโอน" ตาม Canvas · ระหว่างรอชำระรายละเอียดถูกล็อก มีปุ่ม "เปลี่ยนรายละเอียด" (เริ่มคำขอใหม่ด้วย key ใหม่)
- **นิติบุคคล / บุคคลธรรมดา** API ไม่เก็บ (`billing_profiles` ไม่มีคอลัมน์) จึงเปิดหน้าที่ "นิติบุคคล" เสมอ · บุคคลธรรมดาส่ง `branchType: head` และหัก ณ ที่จ่ายไม่ได้ · ค่าเริ่มต้นของช่องหัก ณ ที่จ่ายมาจาก `profile.whtEnabled` (ไม่มี profile = ติ๊กไว้ตาม Canvas)
- "ทีมปัจจุบัน 12 คน (ไม่นับ Guest 2 คน)" แสดงเฉพาะจำนวนสมาชิก เพราะ `GET usage` ไม่บอกจำนวน Guest · ทีมเกินแพ็กเกจที่เลือก = ข้อความสีแดง
- **Q2 ที่ API ยังไม่รองรับ** (A29 บันทึกไว้): ช่วงผ่อนผัน 14 วัน, อ่านอย่างเดียวเมื่อค้างชำระ, เลขใบแจ้งหนี้ที่ค้างในแบนเนอร์, "เลือก 3 โปรเจกต์ที่ใช้ต่อ", "ไม่ได้เข้า 54 วัน", ไฟล์ใหญ่สุด 10 ไฟล์ · ข้อความแบนเนอร์ / Dialog จึงบอกเฉพาะสิ่งที่ระบบทำจริง (เชิญเพิ่มไม่ได้, ข้อมูลไม่หาย) · "ขอให้ Admin อัปเกรด" ยังไม่มี endpoint จึงขึ้น toast ให้แจ้ง Owner/Admin เอง · "ทดลอง Team ฟรี 14 วัน" ใน Dialog / FeatureLock เป็น "เปลี่ยนแพ็กเกจ" / "อัปเกรดเป็น Team" เพราะไม่มี endpoint เริ่มทดลองใหม่ · Member เห็นแบนเนอร์ทดลองเฉพาะวันสุดท้าย และ "รับทราบ" ซ่อนถึงสิ้นวัน (sessionStorage)
- **กฎหมาย**: ไม่มี endpoint PDF จึงใช้ "พิมพ์ / บันทึก PDF" (`window.print`) · "รับแจ้งเตือนทางอีเมล" ของผู้ให้บริการช่วงไม่ทำ (ไม่มี endpoint) · แบนเนอร์ข้อกำหนดเปลี่ยนแสดงเฉพาะ `terms` / `privacy` / `dpa` ที่ยังไม่รับทราบ
- `/billing` ไม่มี Canvas ของตัวเอง (Checkout ลิงก์ไป AdminConsole › แพ็กเกจ & Billing) จึงทำตามส่วน "แพ็กเกจ & Billing" ใน `AdminConsole.dc.html` แบบย่อ
- **dependency ใหม่**: `qrcode` + `@types/qrcode` สำหรับวาด QR PromptPay จาก payload (dynamic import) · Stripe.js ไม่ได้เพิ่มเป็นแพ็กเกจ

### คำขอนอก lane

- **W00 · `src/components/providers.tsx`**: แทน `<Dialog>` ทั่วไปของ 402 ใน `ApiEvents` ด้วย `<PlanLimitHost />` จาก `@/features/plan-limits` (ลบ state `limit` และ listener `API_PLAN_LIMIT` เดิม) · ก่อนแก้ไฟล์นี้ Dialog ของ Q2 ยังไม่ถูกวางที่ไหน
- **W00 · `src/components/shell/workspace-shell.tsx`**: วาง `<WorkspaceBanners ws={workspace.slug} role={workspace.role} />` ใต้แถบบน (เหนือเนื้อหา) เพื่อให้แบนเนอร์ทีมเกินแพ็กเกจ / ทดลองใกล้หมด / ค้างชำระ / ข้อกำหนดเปลี่ยนแสดงทุกหน้า · และเพิ่มลิงก์ `nav.billing` (มีข้อความแล้ว) ไป `/w/{ws}/billing` ในเมนู Admin
- **W00 · `src/i18n/messages.ts`**: เพิ่ม namespace `saas-pages` เมื่อวาง `PlanLimitHost` / `WorkspaceBanners` ใน shell (test ที่ render shell ต้องมีข้อความ · ฝั่ง server โหลดทุกไฟล์อยู่แล้ว)
- **W08 (Gantt) และหน้าฟีเจอร์ Team อื่น**: ครอบเนื้อหาด้วย `<FeatureLock ws feature="Gantt" canManage>` เมื่อ `GET usage` → `plan.code === "free"` · **W18**: ใช้ `<AutomationQuotaBanner usage={data.usage} canManage href>` ในหน้า Automation
- **A29**: endpoint "ขอให้ Admin อัปเกรด" (แจ้ง Inbox ของ Owner/Admin พร้อมชื่อฟีเจอร์), จำนวน Guest ใน `GET usage`, ช่วงผ่อนผัน / อ่านอย่างเดียวตาม Q2 · **A33**: ตัดบัตรอัตโนมัติรอบถัดไป และ endpoint ขอ QR ใหม่ของใบแจ้งหนี้เดิม (ตอนนี้ QR หมดอายุต้อง checkout ใหม่ = ใบแจ้งหนี้ใหม่) · **T00**: คอลัมน์ประเภทผู้ซื้อ (นิติบุคคล / บุคคลธรรมดา) ใน `billing_profiles`
- **W01**: การ์ดราคาส่ง `?plan=&cycle=` ไป `/signup` · ถ้าต้องการพาไปชำระเงินหลังสร้าง Workspace ให้ส่งต่อไป `/w/{ws}/billing/checkout?plan=&cycle=`
- **`.env.example` / I01**: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SELLER_NAME`, `NEXT_PUBLIC_SELLER_TAX_ID`, `NEXT_PUBLIC_SALES_URL` (อ่านตอน build) · ถ้ามี CSP ต้องอนุญาต `https://js.stripe.com` (script + frame)

### ผล test

- `src/lib/saas-pages.test.tsx` 23 ข้อ (MSW, mock Stripe.js, ข้อมูลสมมติ): Landing (ราคา, ขนาดทีม → แพ็กเกจแนะนำ, รายปี, ตารางเปรียบเทียบ, FAQ, ลิงก์) · /pricing Error + requestId + ลองอีกครั้ง · กฎหมาย (สารบัญ, แท็บ, ประวัติเวอร์ชัน, 404 → โครงหัวข้อ, ผู้ให้บริการช่วง, 500) · Cookie (ปฏิเสธ / ตั้งค่า / ยอมรับ / ไม่ถามซ้ำ / เปิดจาก footer / ปุ่มน้ำหนักเท่ากัน) · แบนเนอร์ข้อกำหนดเปลี่ยน · Checkout บัตร (prefill, PUT profile, POST checkout + Idempotency-Key + PO, `confirmCardPayment(client_secret)`, poll → สำเร็จ) · key ใช้ซ้ำเมื่อ 5xx และเป็น key ใหม่เมื่อเปลี่ยนแพ็กเกจ, บัตรถูกปฏิเสธ · ตรวจข้อมูลภาษี / บุคคลธรรมดา · PromptPay + หัก 3% (quote `wht=true`, QR SVG, นับถอยหลัง, ยังไม่จ่าย / จ่ายแล้ว) · โอน (เลขบัญชี, PDF, สลิป multipart → รอตรวจ) · ไม่มีกุญแจ Stripe · สิทธิ์ (Member ไม่เรียก API, 403, 500) · Billing (มิเตอร์, ใบแจ้งหนี้, สลิป, 50 ทวิ, ยกเลิกโดย Owner, Admin ไม่มีปุ่มยกเลิก, ว่าง, Member, 500, NotFound) · Q2 ครบ 7 สถานการณ์ (402 seats / projects / storage, FeatureLock, ทดลอง Owner/Member + รับทราบ, ค้างชำระ + ทีมเกิน, Guest ไม่เรียก API, Automation)
- `pnpm --filter @friday/web typecheck`, `test` (292 ข้อหลัง rebase), `build` ผ่าน
- ยังไม่ได้เทียบภาพกับ Canvas ที่ 1440 / 390 px
