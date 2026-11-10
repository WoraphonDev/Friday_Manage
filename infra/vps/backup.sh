#!/usr/bin/env bash
# สำรองฐานข้อมูล (pg_dump แบบ custom) และไฟล์ที่ลูกค้าอัปโหลด · เก็บ 14 วันบนเครื่อง
# cron รันทุกวัน (setup-server.sh) · ยังเป็นสำเนาบนเครื่องเดียวกัน ถ้าดิสก์เสียจะหายด้วย ต้องดึงออกนอกเครื่องเป็นระยะ (README)
set -euo pipefail
cd /opt/friday
KEEP_DAYS="${KEEP_DAYS:-14}"
stamp=$(date +%Y%m%d-%H%M%S)
out=backups

docker compose exec -T postgres pg_dump -U friday_owner -d friday -Fc >"$out/db-$stamp.dump.part"
mv "$out/db-$stamp.dump.part" "$out/db-$stamp.dump"

# volume uploads อ่านผ่าน container ชั่วคราว (ไม่ต้องรู้ path ของ Docker บนเครื่อง)
docker run --rm -v friday_uploads:/data:ro alpine:3.22 tar -C /data -czf - . >"$out/uploads-$stamp.tgz.part"
mv "$out/uploads-$stamp.tgz.part" "$out/uploads-$stamp.tgz"

find "$out" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$out" -name 'uploads-*.tgz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: db-$stamp.dump ($(du -h "$out/db-$stamp.dump" | cut -f1)), uploads-$stamp.tgz"
