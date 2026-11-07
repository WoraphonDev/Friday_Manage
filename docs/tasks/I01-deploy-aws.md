# I01 · Deploy บน AWS + GlitchTip

| | |
|---|---|
| Wave | 3 · ปิดท้าย |
| รอ merge | T01 |
| Lane (แก้ได้เฉพาะ) | `infra/**` · `Dockerfile*` · `apps/api/src/main.ts` · `apps/api/src/instrument.ts` |
| หน้าจอ | — |
| สเปก | docs/tech-stack.md (AWS, GlitchTip, region ไทย) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- Dockerfile ของ api, worker, web · IaC ใน `infra/` (เลือก CDK หรือ Terraform แล้วเขียนเหตุผล)
- RDS PostgreSQL 18, ElastiCache Valkey, S3, ECS Fargate, ALB + TLS, Secrets Manager สำหรับบัญชี friday_api / friday_worker
- GlitchTip (Sentry SDK) ใน api และ web · migration ตอน deploy
- Workflow deploy ใน `.github/workflows/deploy.yml` (ขอ T01 หรือทำหลัง T01 merge)

## กติกาที่ต้องตรง

- ไม่ deploy จริงจนกว่าผู้ใช้อนุมัติค่าใช้จ่าย

## เสร็จเมื่อ

- [x] `cdk synth` / `terraform plan` ผ่าน · image build ผ่านใน CI

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### Docker เว็บในเครื่อง · 7 พฤศจิกายน 2569 (ขอบเขตย่อยตามคำสั่งผู้ใช้)

- เพิ่ม `Dockerfile.web` แบบ multi-stage: Node.js 22, pnpm ตาม packageManager, Next.js standalone พร้อม static/public และผู้ใช้ node · ใช้ `Dockerfile.web.dockerignore` จำกัด context เฉพาะเว็บและ manifest
- เพิ่ม `infra/docker/compose.web.yml` และวิธีรันใน `infra/docker/web.md` แยกจาก Compose ฐานข้อมูลเดิม เปิดเฉพาะ loopback พอร์ต 3000 และเชื่อม API เดิมผ่าน host.docker.internal:3001
- API_ORIGIN เป็น build argument เพราะ Next.js บันทึก rewrite ตอน build · เปลี่ยนปลายทางต้อง build ใหม่
- ทดสอบ build image บน Docker Desktop (linux/arm64) สำเร็จ รวม TypeScript ของ production build; container healthy รันด้วยผู้ใช้ node · มี warning เดิม 2 รายการเรื่อง dynamic filesystem tracing ของ locale-switch
- ตรวจ HTTP หน้า Landing ภาษาไทย, static assets 14 รายการ, CSRF/ล็อกอิน/session/ข้อมูลโปรเจกต์ด้วยบัญชีสมมติ ผ่าน proxy และ WebSocket พร้อม subscribe user channel ผ่านทั้งหมด
- ใช้ http://localhost:3000 ให้ตรง WEB_URL เดิมของ API; พอร์ต 8080 เดิมไม่ผ่าน Origin ของ realtime จึงหยุดเฉพาะ dev server ที่เปิดใน session นี้แล้วให้ container ใช้พอร์ต 3000 แทน ไม่เปลี่ยน origin validation ของ API
- ไม่รันชุดทดสอบ API ซ้ำกับฐานข้อมูลที่ผู้ใช้กำลังดู; source ของแอปตรง main 96cc33a ที่ผ่าน CI แล้ว การเปลี่ยนแปลงนี้เป็น packaging และเอกสารเท่านั้น
- งานนี้ยังไม่ครบ I01: ไม่รวม API/worker image, IaC, AWS, GlitchTip หรือ CI build image จึงยังไม่ติ๊กเกณฑ์เสร็จของ I01

### AWS + GlitchTip · 8 พฤศจิกายน 2569

- **IaC: AWS CDK (TypeScript)** ใน `infra/aws` (แพ็กเกจ npm แยกจาก pnpm workspace) · เหตุผล: ภาษาเดียวกับแอป, `cdk synth` / test ไม่ต้องมีบัญชี AWS, สิทธิ์ระหว่างทรัพยากรสร้างให้ · รายละเอียดและขั้นตอน deploy ครั้งแรกอยู่ใน [infra/aws/README.md](../../infra/aws/README.md)
- Stack: `FridayRegistry` (ECR), `FridayCi` (OIDC ของ GitHub + role deploy), `FridayApp` (VPC, RDS PostgreSQL 18, ElastiCache Valkey 8 `noeviction`, S3, Secrets Manager `friday/db/*` + `friday/app`, ECS Fargate ARM64 api / worker / web / migrate, ALB + ACM, Logs)
- `Dockerfile.api` ใช้ร่วม API และ Worker · migration ตอน deploy ด้วย `infra/docker/deploy-migrate.mjs` (drizzle-orm migrator + สร้าง / หมุนรหัสผ่าน `friday_api`, `friday_worker`) · `api-entrypoint.sh` ประกอบ URL ฐานข้อมูลจาก secret · TLS ไป RDS ด้วย `sslmode=verify-full` และ CA ของ RDS
- `GET /healthz` ใน `main.ts` สำหรับ ALB / ECS (ไม่ผ่าน DB)
- GlitchTip: `apps/api/src/instrument.ts` (Sentry SDK + Logger ที่ส่ง error 5xx จาก ErrorFilter) และ `apps/web/instrumentation*.ts` · ไม่ตั้ง DSN = ปิด
- `.github/workflows/deploy.yml`: build image ARM64 ทุก PR / push (ไม่ push) + CDK typecheck / test / synth · deploy จริงผ่าน Run workflow + environment `production` เท่านั้น ลำดับ push image → migrate ด้วย image ใหม่ → `cdk deploy` · มีโหมด `first_deploy`
- ทดสอบในเครื่อง: build image API, migration กับฐานข้อมูลทดลอง 2 รอบ (13 ไฟล์, รันซ้ำได้), เปิด API (`/healthz`, CSRF, `public/plans`) และ Worker (ต่อ Valkey, งานตามเวลา 12 รายการ) จาก image เดียวกัน · build image เว็บที่มี Sentry แล้ว `/login` 200 · CDK test 8 ข้อ, synth ทั้งมีและไม่มีใบรับรอง
- **ยังไม่ deploy จริง** ตามกติกา (รออนุมัติค่าใช้จ่าย) · ความเสี่ยงที่ต้องดูครั้งแรก: BYPASSRLS บน RDS, บริการที่มีใน ap-southeast-7, ค่าเริ่มต้นเป็น single-AZ, ยังไม่มี ClamAV (ดู README)
- คำขอนอก lane: `apps/api/src/worker.ts` (Logger ของ GlitchTip), `apps/web/instrumentation*.ts` + `@sentry/nextjs` (W00), `packages/db/package.json` เพิ่ม `@opentelemetry/api` ให้ `drizzle-orm` เป็นชุดเดียวกับ API (ถ้าไม่ใส่ type ของ drizzle ชนกันหลังติดตั้ง Sentry · T00), `.github/workflows/deploy.yml` (T01), `Dockerfile.web` รับ DSN ตอน build
- CI ของ PR #91: build image API / เว็บ (ARM64) และ CDK typecheck / test / synth ผ่าน · job Deploy ข้ามตามที่ตั้งใจ (รันเฉพาะ Run workflow)
