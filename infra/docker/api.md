# รัน API ลูกค้าด้วย Docker ในเครื่อง

API (`apps/api`) รันใน container ที่พอร์ต 3001 แทน `node dist/main.js` บนเครื่อง · เว็บ (:3000) และ ops-api (:4001) เรียกที่เดิมจึงไม่ต้องแก้อะไร

```sh
# หยุด API ที่รันบนเครื่องก่อน (ถ้ามี) แล้ว build + เปิด
docker compose -f infra/docker/compose.api.yml up --build --force-recreate -d
docker compose -f infra/docker/compose.api.yml ps
docker compose -f infra/docker/compose.api.yml logs --tail 50 api
```

- ใช้ฐานข้อมูล QA เดิม `friday_canvas_qa` ผ่าน `host.docker.internal:54329` · ไม่ล้าง ไม่ reseed · migration ยังรันเองด้วย `pnpm db:migrate` (ตั้ง `DATABASE_OWNER_URL` ไปที่ `friday_canvas_qa`)
- ไฟล์อัปโหลดอยู่ที่ `apps/api/var/uploads` (bind mount) · ops-api อ่านที่เดียวกันแบบอ่านอย่างเดียว
- `NODE_ENV=development`: ยังไม่มี Gateway จริง (A35b) และ secret ของ production จึงใช้ตัวจำลองการชำระเงินและ secret dev เดิม (session เดิมใช้ต่อได้) · เปลี่ยนด้วย `API_NODE_ENV` เมื่อมี secret ครบ
- คิวงานทำใน process เดียวกับ API · ใช้ Valkey ตั้ง `API_VALKEY_URL=redis://host.docker.internal:6379`
- Webhook ส่งเข้าที่อยู่ภายในได้ (`WEBHOOK_ALLOW_PRIVATE=1`) เพื่อให้โปรเจกต์ FM ส่งสถานะงานเข้า ops-api ที่ `http://host.docker.internal:4001/ops/hooks/fm` (O36) · ปิดด้วย `API_WEBHOOK_ALLOW_PRIVATE=0`
- เปลี่ยนพอร์ต / ฐานข้อมูล: `API_PORT`, `API_DATABASE_APP_URL`, `API_DATABASE_SYSTEM_URL` · Origin ของเว็บ: `APP_URL`, `WEB_URL`, `REALTIME_ALLOWED_ORIGINS`
- แก้โค้ด API แล้วต้อง build image ใหม่ด้วยคำสั่งด้านบน (dev server / `node dist/main.js` ไม่ใช่ผลทดสอบสุดท้าย)
