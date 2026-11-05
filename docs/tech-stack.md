# Tech Stack

สถานะ: **ตกลงในหลักการแล้ว (5 พ.ย. 2569) ยังไม่เริ่มเขียนโค้ด** · บางเรื่องรอให้ UI ล็อกก่อน (Gantt, ระดับ Realtime)

## Frontend

| ใช้ทำอะไร | เลือกใช้ |
|---|---|
| Web app + Landing (SEO) | Next.js + React + TypeScript |
| UI components (รองรับ Accessibility) | Tailwind CSS + shadcn/ui (Radix) |
| ตารางลำดับชั้น 1,000+ แถว | TanStack Table + TanStack Virtual |
| ลากการ์ด / ลากเข้า Sprint | dnd-kit |
| Gantt + Timeline | **เขียนเองด้วย SVG** (สำรอง: Syncfusion Community License) |
| ปฏิทิน | FullCalendar |
| Command palette (Ctrl K) | cmdk |
| กราฟ | Apache ECharts หรือ Recharts |
| คอมเมนต์ + @mention | TipTap |
| ภาษา TH/EN และปี พ.ศ. | next-intl + date-fns |
| มือถือ | Responsive web / PWA + Web Push |

## Backend

| ใช้ทำอะไร | เลือกใช้ |
|---|---|
| API | NestJS (TypeScript) · REST + OpenAPI |
| ฐานข้อมูล | PostgreSQL (Row-Level Security แยกตาม Workspace) + Prisma หรือ Drizzle |
| คิวงานเบื้องหลัง (สรุปรายวัน, รายงานรายสัปดาห์, Automation, Webhook retry) | Valkey (แทน Redis) + BullMQ |
| Realtime | WebSocket (Socket.IO) |
| ค้นหา | PostgreSQL Full-text → OpenSearch เมื่อต้องค้นในไฟล์ / ตัดคำไทย |
| Import / Export Excel | ExcelJS |
| Export PDF | Playwright |
| ไฟล์แนบ | S3 + PDF.js + ClamAV |

## Integration และ SaaS

| ใช้ทำอะไร | เลือกใช้ | ช่วงแรก |
|---|---|---|
| Login | อีเมล + รหัสผ่าน, Google, Microsoft, 2FA (Auth.js / Better Auth หรือ Keycloak) | ✓ |
| SSO แบบ SAML (ลูกค้า Enterprise) | Keycloak หรือ WorkOS | **ทำทีหลัง** แต่ออกแบบตารางผู้ใช้ให้ 1 คนผูกได้หลายวิธีล็อกอินตั้งแต่แรก |
| Email | ระบบส่งอีเมลที่สลับผู้ให้บริการได้ | **ทำไว้แต่ปิด** · ช่วงแรกใช้ SMTP ของบริษัท + ลิงก์เชิญ + Google login · เปิด SaaS ใช้ Amazon SES |
| LINE | LINE Messaging API (Flex Message + Postback) | ✓ โควตาฟรีพอสำหรับทีมเดียว |
| Webhook | Webhook ทั่วไป ลงลายเซ็น HMAC | ✓ |
| Git | GitHub App + GitLab Webhook | ✓ |
| ชำระเงิน | **Stripe** (บัตร + PromptPay + Billing) | ตอนเปิด SaaS |
| ใบกำกับภาษี | ผู้ให้บริการ e-Tax Invoice · หัก ณ ที่จ่าย 3% ทำเองในใบแจ้งหนี้ | ตอนเปิด SaaS |
| ดู Error | **GlitchTip** (ใช้ SDK เดียวกับ Sentry ย้ายภายหลังได้) | ✓ |
| Hosting | AWS (มี Region ประเทศไทย) + Docker + ECS / Kubernetes | ✓ |
| CI/CD | GitHub Actions | ✓ |

## ค่าใช้จ่าย

- **ช่วงแรก (ใช้กันเองในทีม):** AWS + Domain เท่านั้น
- **ตอนเปิด SaaS:** เพิ่ม Amazon SES, ค่าธรรมเนียม Stripe ต่อรายการ, ผู้ให้บริการ e-Tax และค่า LINE ตามปริมาณข้อความ
- **ข้อควรระวังเรื่อง LINE:** ถ้าใช้ LINE OA ของ Friday ตัวเดียวส่งให้ลูกค้าทุกราย Friday ต้องจ่ายค่าข้อความแทนทั้งหมด ทางเลือกคือให้แต่ละ Workspace ผูก LINE OA ของตัวเอง

## ข้อควรระวังเรื่อง License

- DHTMLX Gantt รุ่นฟรีเป็น GPL ใช้ใน SaaS แบบปิดโค้ดไม่ได้
- ใช้ Valkey แทน Redis เพื่อไม่ต้องติดตามการเปลี่ยน License
- TipTap, BullMQ และ SheetJS มีรุ่น Pro แบบเสียเงิน ตอนนี้ยังไม่ต้องใช้

> เงื่อนไข License และการรองรับประเทศไทยของ Stripe ยังไม่ได้ตรวจกับเว็บไซต์ผู้ให้บริการล่าสุด ควรตรวจก่อนตัดสินใจขั้นสุดท้าย
