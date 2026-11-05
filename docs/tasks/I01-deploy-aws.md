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

- [ ] `cdk synth` / `terraform plan` ผ่าน · image build ผ่านใน CI

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->
