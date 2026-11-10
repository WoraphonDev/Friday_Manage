# รันเว็บด้วย Docker ในเครื่อง

รันจากราก repo โดยเปิด API ที่พอร์ต 3001 ไว้ก่อน (`infra/docker/compose.api.yml` · ดู `api.md`) และหยุด dev server ที่ใช้พอร์ต 3000:

```sh
docker compose -f infra/docker/compose.web.yml up --build -d
```

เปิด <http://localhost:3000> · ใช้ API และฐานข้อมูลชุดเดิม จึงเข้าด้วยบัญชีทดสอบเดิมได้

ตรวจสถานะและหยุดเฉพาะเว็บ:

```sh
docker compose -f infra/docker/compose.web.yml ps
docker compose -f infra/docker/compose.web.yml logs --tail 50 web
docker compose -f infra/docker/compose.web.yml down
```

เปลี่ยนพอร์ตหรือปลายทาง API ได้ดังนี้:

```sh
WEB_PORT=8081 WEB_API_ORIGIN=http://host.docker.internal:3001 \
  docker compose -f infra/docker/compose.web.yml up --build -d
```

เมื่อเปลี่ยนพอร์ตหรือ hostname ให้ตั้ง `WEB_URL` หรือ `REALTIME_ALLOWED_ORIGINS` ของ API ให้ตรงกับ Origin ที่เปิดในเบราว์เซอร์ด้วย เช่น `REALTIME_ALLOWED_ORIGINS=http://localhost:8081` แล้วเปิด API ใหม่ เพื่อให้ realtime ผ่านการตรวจ Origin

`WEB_API_ORIGIN` ต้องเข้าถึงได้จาก container และต้อง build image ใหม่เมื่อเปลี่ยนค่า เพราะ Next.js บันทึก rewrite ตอน build หากย้าย API เข้า Docker network เดียวกัน ให้ใช้ชื่อ service เช่น `http://api:3001` แทน `localhost`

Image ใช้ Next.js standalone พร้อม static assets และไฟล์ภาษา รันด้วยผู้ใช้ `node` และเปิดพอร์ตเฉพาะเครื่องนี้ ขอบเขตนี้เป็นการรันเว็บใน Docker บนเครื่อง API อยู่ใน `compose.api.yml` แยกต่างหาก · ยังไม่รวมการขึ้น AWS
