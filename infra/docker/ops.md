# รัน Friday Ops (หลังบ้าน) ด้วย Docker ในเครื่อง

หน้าเว็บ ops-web ที่ <http://localhost:4000> · API ops-api ที่ <http://localhost:4001> · ใช้ฐานข้อมูล PostgreSQL ของเครื่อง (`friday_canvas_qa` เป็นค่าเริ่มต้น) และ API ลูกค้าที่พอร์ต 3001

```sh
docker compose -f infra/docker/compose.ops.yml up --build --force-recreate -d
docker compose -f infra/docker/compose.ops.yml ps
docker compose -f infra/docker/compose.ops.yml logs --tail 50 ops-api ops-web
```

- ops-web เรียก ops-api ผ่าน `/ops-api/*` ใน Docker network (`http://ops-api:4001`) · cookie `fm_ops` และ Origin จึงเป็น `http://localhost:4000` ตรงกับ `OPS_WEB_ORIGIN`
- Security key (WebAuthn) ใช้ RP ID `localhost` เหมือนตอน dev · กุญแจที่ลงทะเบียนไว้เดิมใช้ได้
- งานเบื้องหลังปิดไว้ (`OPS_JOBS=off`) เพราะใช้ข้อมูลทดสอบ · ถ้าจะเปิดให้ตั้ง `OPS_JOBS=on` และ `OPS_VALKEY_URL`
- ส่งไฟล์บัญชีให้สำนักงานบัญชี (B8): ตั้ง `OPS_ACCOUNTING_EMAIL` (คั่นด้วยจุลภาค) · ส่งเองได้จากหน้ารายได้ · งานอัตโนมัติส่งไฟล์ของเดือนก่อนตั้งแต่วันที่ `OPS_ACCOUNTING_SEND_DAY` (ค่าเริ่มต้น 5) เมื่อเปิด `OPS_JOBS`
- Web Push ของ Friday Ops บนมือถือ (O25 · หน้า `/m`): ในเครื่องสร้างกุญแจ VAPID จาก `OPS_AUTH_SECRET` ให้เอง (`OPS_VAPID_DERIVE=on`) · ขึ้นจริงสร้างกุญแจด้วย `npx web-push generate-vapid-keys` แล้วตั้ง `OPS_VAPID_PUBLIC_KEY` / `OPS_VAPID_PRIVATE_KEY` และ `OPS_VAPID_DERIVE=off` · เบราว์เซอร์รับ Push ได้เฉพาะ https หรือ localhost · iPhone ต้องเพิ่มลงหน้าจอโฮมก่อน
- เปลี่ยนฐานข้อมูล: `OPS_DATABASE_URL=postgres://...@host.docker.internal:54329/<db>` แล้วสั่ง up ใหม่
- เปลี่ยนพอร์ต: `OPS_WEB_PORT` / `OPS_API_PORT` · ถ้าเปลี่ยนพอร์ตเว็บต้องตั้ง `OPS_WEB_ORIGIN` ให้ตรงด้วย
- ห้ามล้าง volume หรือ reseed ฐานข้อมูลเพื่อ deploy
