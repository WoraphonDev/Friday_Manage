# Friday Manage · คำสั่งสำหรับ Claude Code

@AGENTS.md
@infra/docker/web.md

## ก่อนรายงานว่างานแก้ไขเสร็จ

1. ตรวจ typecheck/tests ที่เกี่ยวข้องให้ผ่าน แล้ว build และ deploy แบบ production เข้า Docker ในเครื่องทุกครั้งตามที่ผู้ใช้กำหนด
2. ใช้ checkout ที่มีงานแก้ไขล่าสุดจริง ตรวจ `pwd`, `git branch --show-current`, `git rev-parse --short HEAD` และ `git status --short` ก่อน build รวมถึงระบุถ้ามีงานที่ยังไม่ได้ commit ห้ามไป build จาก checkout เก่าของ main
3. รันจากราก checkout นั้น:

```sh
docker compose -f infra/docker/compose.web.yml up --build --force-recreate -d web
docker compose -f infra/docker/compose.web.yml ps
docker compose -f infra/docker/compose.web.yml logs --tail 50 web
docker compose -f infra/docker/compose.web.yml images
```

4. รอ container healthy แล้วตรวจผ่าน `http://localhost:3000` ทั้งหน้าเว็บ/static assets และ flow ที่แก้จริง งานเกี่ยวกับ auth/API/realtime ต้องตรวจการเชื่อมต่อจริง Dev server เช่นพอร์ต 3918 ไม่ใช่หลักฐานว่า deploy Docker แล้ว
5. API ปัจจุบันยังรันบนเครื่องที่พอร์ต 3001 ถ้าแก้ API ให้ build และเปิด API ของ checkout ที่แก้ด้วย โดยคงฐานข้อมูลทดสอบเดิม เว็บ Docker อย่างเดียวไม่อัปเดต API ให้
6. ถ้า checkout นี้ไม่มี Dockerfile/Compose ให้เอาไฟล์ตั้งค่า Docker ที่ผู้ใช้อนุมัติมาไว้ใน checkout นี้ก่อน ห้ามใช้ Compose จาก worktree เก่า เพราะ build context จะกลายเป็นโค้ดเก่า
7. ห้ามล้างข้อมูลหรือ volume เพื่อ deploy ถ้าทำไม่ผ่านให้แก้หรือบอกสาเหตุตามจริง ห้ามรายงานว่า deploy แล้วเมื่อทำเพียงเปิด dev server
8. ตอนส่งงานรายงาน URL, checkout/branch, commit และสถานะงานที่ยังไม่ commit, image ID, ผล health/smoke test และสถานะ API โดยย่อ การ build/deploy Docker ในเครื่องนี้ได้รับอนุญาตจากผู้ใช้แล้ว ไม่ต้องขอซ้ำ
