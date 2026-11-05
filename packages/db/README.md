# @friday/db

Schema ของ PostgreSQL (Drizzle) และ Row-Level Security ของ Friday Manage · ที่มาของตารางอยู่ใน [docs/spec/01-entities.md](../../docs/spec/01-entities.md) และกติกาสิทธิ์ใน [docs/spec/04-permissions.md](../../docs/spec/04-permissions.md)

## เริ่มใช้งานในเครื่อง

```bash
pnpm install
pnpm db:up        # PostgreSQL 18 ใน Docker ที่พอร์ต 54329
pnpm db:migrate   # รัน migration ทั้งหมด
pnpm test         # ทดสอบ RLS กับฐานข้อมูลจริง
```

ถ้า `docker compose` ดึง image ไม่ได้เพราะหา `docker-credential-desktop` ไม่เจอ ให้เพิ่ม `/Applications/Docker.app/Contents/Resources/bin` ใน `PATH`

## Migration

| ไฟล์ | สร้างโดย | เนื้อหา |
|---|---|---|
| `0000_init.sql` | `drizzle-kit generate` จาก `src/schema` | 62 ตาราง: บัญชี, Workspace, วันหยุด, โปรเจกต์, งาน, แผน, ไฟล์, Inbox, Audit log |
| `0001_rls.sql` | เขียนเอง (`drizzle-kit generate --custom`) | Role, ฟังก์ชันใน schema `app`, RLS policy, สิทธิ์ตาราง, trigger |

แก้ตาราง: แก้ `src/schema` แล้วรัน `pnpm db:generate` · **ตารางใหม่ที่มี `workspace_id` ต้องเพิ่ม policy ใน migration แบบเขียนเอง** ไม่อย่างนั้น test "ทุกตารางเปิด RLS" จะล้ม

ยังไม่อยู่ใน migration แรก (แยกเป็น migration ถัดไป): ช่องทางแจ้งเตือน (LINE OA, Email, Webhook), Git, Automation, Saved view, API token, SSO, Template, PDPA, แพ็กเกจและการชำระเงิน, หลังบ้านทีม Friday

## Role ของฐานข้อมูล

| Role | ใช้ที่ไหน | RLS |
|---|---|---|
| เจ้าของตาราง | รัน migration เท่านั้น | ข้าม |
| `friday_app` | API ตอนทำงาน (บัญชีล็อกอินเป็นสมาชิกของ role นี้) | **บังคับ** |
| `friday_system` | Sign up / Login, ตอบรับคำเชิญ, งานเบื้องหลัง, Webhook ขาเข้า | ข้าม · ใช้เฉพาะจุดที่ยังไม่รู้ Workspace |

## ใช้ใน API

```ts
import { createDb, withTenant, schema } from '@friday/db';

const db = createDb(process.env.DATABASE_APP_URL!);

const rows = await withTenant(db, { userId, workspaceId }, (tx) =>
  tx.select().from(schema.issues).where(eq(schema.issues.projectId, projectId)),
);
```

`withTenant` ตั้ง `app.user_id` และ `app.workspace_id` เฉพาะในธุรกรรม RLS จึงกรองให้อัตโนมัติ:
1. แถวต้องอยู่ใน Workspace ปัจจุบัน และผู้ใช้ต้องเป็นสมาชิก active
2. งานและข้อมูลในโปรเจกต์: ต้องเป็น Project Owner, สมาชิกโปรเจกต์ หรือโปรเจกต์เปิดทั้ง Workspace (ไม่รวม Guest) · Workspace Owner / Admin เห็นแค่แถวโปรเจกต์จนกว่าจะเข้าร่วม

สิทธิ์ละเอียด เช่น `issue.edit`, `issue.change_due_directly` และการซ่อนข้อมูลของ Guest ตรวจที่ API ไม่ใช่ที่ฐานข้อมูล
