# Friday Manage บน VPS เครื่องเดียว (staging)

ทางเลือกที่ถูกกว่า AWS ([infra/aws](../aws/README.md)) สำหรับช่วงทดสอบ · ทุกอย่างอยู่ในเครื่องเดียวด้วย Docker Compose

| service | หน้าที่ | RAM สูงสุด |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt อัตโนมัติ) · `/api/*` → api · ที่เหลือ → web · ops host → ops-web | 96 MB |
| `postgres` | PostgreSQL 18 ปรับให้พอดี RAM 2 GB | 384 MB |
| `valkey` | คิว BullMQ (`noeviction`, AOF) | 96 MB |
| `api` / `worker` | image เดียวกัน (`Dockerfile.api`) ต่างกันที่คำสั่ง | 384 / 320 MB |
| `web` | Next.js standalone | 256 MB |
| `ops-api` / `ops-web` | Friday Ops (หลังบ้าน) | 256 / 224 MB |

ใช้ RAM จริงน้อยกว่าเพดานรวม · เครื่องมี swap 2 GB สำรองช่วงที่ทุกตัวเริ่มพร้อมกัน

## ทำไมไม่ build บนเครื่อง

RAM 2 GB ไม่พอ build Next.js · `deploy.sh` build image `linux/amd64` บน Mac (Docker Desktop จำลองด้วย Rosetta) แล้วส่งขึ้นเครื่องด้วย `docker save | ssh docker load` · ไม่ต้องมี registry และไม่ต้องเก็บ token บนเครื่อง

## ตั้งเครื่องครั้งแรก

1. ใส่ public key ของ `~/.ssh/friday_vps` ใน `/root/.ssh/authorized_keys` ของเครื่อง
2. `ssh -i ~/.ssh/friday_vps root@<ip> 'bash -s' < infra/vps/setup-server.sh <ip>`
   - อัปเดตแพ็กเกจ · ปิดการเข้าด้วยรหัสผ่าน · ufw เปิด 22/80/443 · fail2ban · swap · Docker · cron backup
   - สร้าง `/opt/friday/.env` พร้อม secret ที่สุ่มใหม่ (มีอยู่แล้ว = ไม่แตะ)

## Deploy

รันจากราก checkout ที่จะขึ้น (ต้อง commit แล้ว · tag ของ image = commit สั้น):

```sh
infra/vps/deploy.sh
# เครื่องอื่น: VPS_HOST=root@<ip> VPS_KEY=~/.ssh/<key> infra/vps/deploy.sh
```

ขั้นตอน: build 4 image → ส่งขึ้นเครื่อง → ส่ง compose/Caddyfile/backup.sh → `run --rm migrate` (migration + รหัสผ่าน friday_api / friday_worker) → `up -d` → รอทุก service healthy → เก็บ image 2 รุ่นล่าสุด

ย้อนรุ่น: แก้ `TAG=` ใน `/opt/friday/.env` เป็นรุ่นก่อนหน้า (`docker image ls friday-api`) แล้ว `docker compose up -d` · migration ไม่ย้อนเอง

## ค่าที่ต้องรู้

- **ยังไม่มีโดเมน**: ใช้ `app.<ip-ขีด>.sslip.io` / `ops.<ip-ขีด>.sslip.io` (DNS สาธารณะที่ชี้ชื่อกลับมาที่ IP ในชื่อ) · ได้ใบรับรองจริง จึงทดสอบ cookie แบบ Secure, Web Push และ Webhook ได้ · ไม่ควรให้ลูกค้าจริงใช้
- **เปลี่ยนเป็นโดเมนจริง**: ชี้ DNS A ของ `app` และ `ops` มาที่ IP · แก้ `APP_HOST` / `OPS_HOST` ใน `.env` · `docker compose up -d` (ไม่ต้อง build ใหม่ เพราะ web เรียก API ผ่านชื่อ service ภายใน) · Security key ของพนักงาน Ops ผูกกับชื่อ host ต้องลงทะเบียนใหม่
- **ชำระเงิน**: ยังไม่มี Gateway จริง (A35b) · `PAYMENT_GATEWAY=fake` ใช้ได้เฉพาะเมื่อ `STRIPE_WEBHOOK_SECRET` ยาว ≥ 32 ตัวอักษร (กันการปิดใบแจ้งหนี้ด้วยลายเซ็น dev ใน repo)
- **อีเมล**: ไม่ตั้ง `SMTP_*` = ไม่ส่ง (เขียน log) · ลิงก์ยืนยันอีเมล / รีเซ็ตรหัสผ่าน / เชิญสมาชิกจะไม่ถึงผู้ใช้
- **Owner คนแรกของ Ops**: `docker compose exec ops-api node dist/enroll.js <email> <ชื่อ> owner` แล้วเปิดลิงก์ลงทะเบียน Security key

## Backup

`backup.sh` รันทุกวัน 03:15 · `pg_dump -Fc` + tar ของไฟล์อัปโหลด · เก็บ 14 วันใน `/opt/friday/backups`

**สำเนาอยู่บนดิสก์เดียวกับข้อมูล** ถ้าเครื่องเสียจะหายด้วย · ดึงออกเป็นระยะ:

```sh
rsync -av -e "ssh -i ~/.ssh/friday_vps" root@<ip>:/opt/friday/backups/ ~/friday-backups/
```

กู้ฐานข้อมูล: `docker compose exec -T postgres pg_restore -U friday_owner -d friday --clean --if-exists < backups/db-<เวลา>.dump`

## ตรวจสถานะ

```sh
ssh -i ~/.ssh/friday_vps root@<ip>
cd /opt/friday && docker compose ps && docker stats --no-stream && free -m
docker compose logs --tail 100 api
```
