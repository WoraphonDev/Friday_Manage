# Friday Manage บน AWS (CDK)

โครงสร้างพื้นฐานสำหรับ production ใน region ประเทศไทย (`ap-southeast-7`) ตาม [docs/tech-stack.md](../../docs/tech-stack.md) · **ยังไม่เคย deploy จริง** ต้องให้ผู้ใช้อนุมัติค่าใช้จ่ายก่อน (I01)

## ทำไมใช้ CDK

- เขียนด้วย TypeScript เหมือนแอป ทีมอ่านและรีวิวได้เลย ไม่ต้องเรียน HCL
- `cdk synth` และ test รันได้โดยไม่ต้องมีบัญชี AWS จึงตรวจใน CI ได้ทุก PR
- สร้าง IAM policy / security group ระหว่างทรัพยากรให้เอง (`grantReadWrite`, `connections`) ลดการเขียนสิทธิ์ผิด
- ข้อเสียที่ยอมรับ: ผูกกับ AWS · state อยู่ใน CloudFormation · ถ้าย้ายไป Kubernetes ภายหลังต้องเขียนใหม่ส่วน ECS

## มีอะไรบ้าง

| Stack | ทรัพยากร |
|---|---|
| `FridayRegistry` | ECR `friday-api`, `friday-web` (tag ห้ามเขียนทับ, เก็บ 30 รุ่น) |
| `FridayCi` | OIDC ของ GitHub + role `friday-github-deploy` (assume ได้เฉพาะ environment `production`) |
| `FridayApp` | VPC 2 AZ (NAT 1 ตัว) · RDS PostgreSQL 18 (`t4g.small`, เข้ารหัส, บังคับ TLS, backup 14 วัน, ลบไม่ได้) · ElastiCache Valkey 8 (`noeviction` สำหรับ BullMQ, TLS) · S3 ไฟล์แนบ (ปิด public, versioned) · Secrets Manager · ECS Fargate ARM64: `api`, `worker`, `web`, task `migrate` · ALB + ACM (HTTP → HTTPS, `/api/*` ไป API รวม WebSocket) · CloudWatch Logs 30 วัน |

API และ Worker ใช้ image เดียวกัน ([Dockerfile.api](../../Dockerfile.api)) ต่างกันที่คำสั่ง · เว็บใช้ [Dockerfile.web](../../Dockerfile.web)

### บัญชีฐานข้อมูล

- `friday_owner` (master ของ RDS): เจ้าของ schema ใช้รัน migration เท่านั้น
- `friday_api` (RLS) และ `friday_worker` (BYPASSRLS): สร้าง / หมุนรหัสผ่านโดย [deploy-migrate.mjs](../docker/deploy-migrate.mjs) จาก secret `friday/db/api`, `friday/db/worker`
- [api-entrypoint.sh](../docker/api-entrypoint.sh) ประกอบ `DATABASE_*_URL` จาก `DB_HOST` + รหัสผ่าน (`sslmode=verify-full` ด้วย CA ของ RDS ใน image)

### GlitchTip

API, Worker และเว็บใช้ Sentry SDK ส่งไป GlitchTip · ไม่ตั้ง DSN = ปิด
- API / Worker / เว็บฝั่ง server: `SENTRY_DSN` ใน secret `friday/app`
- เว็บฝั่งเบราว์เซอร์: `vars.WEB_SENTRY_DSN` ของ GitHub (ฝังตอน build)
- ยังไม่ได้ตั้งเซิร์ฟเวอร์ GlitchTip เอง · เริ่มด้วย glitchtip.com หรือรันเองภายหลังแล้วเปลี่ยน DSN

## ตรวจในเครื่อง

```sh
cd infra/aws
npm ci
npm run typecheck && npm test
npx cdk synth --quiet -c certificateArn=arn:aws:acm:ap-southeast-7:111111111111:certificate/00000000-0000-0000-0000-000000000000
```

ทดลอง image API ในเครื่อง (ใช้ฐานข้อมูลแยก ไม่ใช่ฐานข้อมูลทดสอบที่ใช้อยู่):

```sh
docker build -f Dockerfile.api -t friday-manage-api:local .
docker run --rm -e DB_HOST=host.docker.internal -e DB_PORT=54329 -e DB_NAME=<ฐานข้อมูลทดลอง> -e DB_SSLMODE=disable \
  -e DB_OWNER_PASSWORD=friday_owner_dev -e DB_API_PASSWORD=friday_api_dev -e DB_WORKER_PASSWORD=friday_worker_dev \
  friday-manage-api:local node /app/packages/db/deploy-migrate.mjs
```

## Deploy ครั้งแรก (หลังอนุมัติค่าใช้จ่าย)

1. ผู้ดูแลบัญชี AWS: `npx cdk bootstrap aws://<account>/ap-southeast-7` แล้ว `npx cdk deploy FridayRegistry FridayCi` (ถ้าบัญชีมี OIDC ของ GitHub อยู่แล้ว ส่ง `-c githubOidcProviderArn=...`)
2. ขอใบรับรอง ACM ของโดเมนใน `ap-southeast-7` · โดเมนคือ `fridaymanage.com` ตาม [docs/decisions.md](../../docs/decisions.md) ตัวแอปใช้ `app.fridaymanage.com`
3. GitHub › Settings › Environments › `production`: เปิด Required reviewers · secret `AWS_DEPLOY_ROLE_ARN` (output ของ `FridayCi`) · vars `DOMAIN_NAME` (`app.fridaymanage.com`), `CERTIFICATE_ARN`, `WEB_SENTRY_DSN` (ไม่บังคับ) · `cdk.json` และ test ใช้ `friday.example.com` ต่อไป เพราะค่าจริงมาจาก `vars.DOMAIN_NAME`
4. Actions › Deploy › Run workflow เลือก `first_deploy` · ระบบสร้าง stack โดยหยุด service ไว้ → รัน migration → เปิด service
   - service จะยังไม่ healthy จนกว่าจะกรอกค่าใน Secrets Manager `friday/app` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_PASS`, `SENTRY_DSN`, `GITHUB_*`) เพราะ secret นี้สร้างพร้อม stack และ API ไม่เปิดใน production ถ้าไม่มี Stripe · กรอกแล้วกด Run workflow อีกครั้ง (ไม่เลือก `first_deploy`)
5. ตรวจ `https://<โดเมน>/login` และ `https://<โดเมน>/api/v1/auth/csrf` · log อยู่ใน CloudWatch กลุ่ม `/friday/app`
6. ชี้ DNS ของโดเมนไปที่ output `LoadBalancerDns`

ครั้งต่อไป: Run workflow โดยไม่เลือก `first_deploy` · workflow push image ตาม commit → migration ด้วย image ใหม่ → `cdk deploy` (ECS rollback เองถ้า task ใหม่ไม่ healthy)

## ความเสี่ยงที่ต้องดูตอน deploy ครั้งแรก

- **BYPASSRLS บน RDS:** migration สร้าง role `friday_system BYPASSRLS` และ `deploy-migrate.mjs` ตั้ง `friday_worker BYPASSRLS` · ต้องยืนยันว่า master user ของ RDS PostgreSQL 18 ทำได้ ถ้าไม่ได้ต้องเปลี่ยนแนวทาง (เช่นใช้ policy แทน BYPASSRLS) ก่อนเปิดใช้
- **บริการใน ap-southeast-7:** ตรวจว่ามี Fargate ARM64, `db.t4g.small`, `cache.t4g.micro` และ Valkey 8 ใน region นี้ ถ้าไม่มีให้เปลี่ยนขนาดผ่าน `-c dbInstanceType=... -c cacheNodeType=...`
- **ทนความเสียหาย:** ค่าเริ่มต้นเป็น single-AZ (RDS, Valkey, NAT) เพื่อลดค่าใช้จ่าย · เมื่อมีลูกค้าจริงให้เปิด `-c dbMultiAz=true` และเพิ่ม NAT / Valkey replica
- **ไฟล์แนบ:** S3 ใช้เมื่อตั้ง `S3_BUCKET` (stack ตั้งให้) · ยังไม่ได้ทดสอบ presigned URL กับ bucket จริง
- **ClamAV:** ยังไม่มีในโครงนี้ (docs/tech-stack.md ระบุไว้) ต้องเพิ่มเป็นงานแยก
