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
- Stripe โหมดทดสอบ: ใส่ `STRIPE_SECRET_KEY` (+ `WEB_STRIPE_PUBLISHABLE_KEY` ให้เว็บ) ใน `infra/docker/.env` แล้ว build API และเว็บใหม่ · Stripe ส่ง Webhook เข้า localhost ไม่ได้ ต้องรัน `stripe listen --forward-to localhost:3001/api/v1/hooks/stripe` (Stripe CLI) แล้วตั้ง `STRIPE_WEBHOOK_SECRET` เป็น whsec ที่ CLI พิมพ์ · ทดสอบบนเครื่อง VPS ง่ายกว่า (ดู infra/vps/README.md)
- เข้าสู่ระบบด้วย Google: สร้าง OAuth client แบบ Web application ใน Google Cloud Console (Google Auth Platform → Clients) ตั้ง Authorized redirect URI เป็น `http://localhost:3001/api/v1/auth/oauth/google/callback` แล้วใส่ `OAUTH_GOOGLE_CLIENT_ID` + `OAUTH_GOOGLE_CLIENT_SECRET` ใน `infra/docker/.env` และ build API ใหม่ · ระหว่างแอปยังเป็นสถานะ Testing ต้องเพิ่มอีเมลใน Audience → Test users · Microsoft ใช้ `OAUTH_MICROSOFT_*` แบบเดียวกัน · ไม่ตั้ง = ปุ่มตอบ `oauth_provider_unavailable`
