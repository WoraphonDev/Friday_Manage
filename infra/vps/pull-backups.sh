#!/usr/bin/env bash
# ดึงไฟล์ backup จาก VPS ลงเครื่องนี้ (สำเนานอกเครื่อง VPS) · install-backup-pull.sh ตั้งให้ launchd รันทุกวัน
# ไม่ลบไฟล์บนเครื่องนี้ตามฝั่ง VPS (ไม่ใช้ --delete) · เก็บเอง KEEP_DAYS วัน
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@45.141.26.85}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/friday_vps}"
DEST="${DEST:-$HOME/FridayBackups/vps}"
KEEP_DAYS="${KEEP_DAYS:-60}"

mkdir -p "$DEST"
chmod 700 "$DEST"
rsync -a -e "ssh -i $VPS_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20" "$VPS_HOST:/opt/friday/backups/" "$DEST/"
find "$DEST" -type f \( -name 'db-*.dump' -o -name 'uploads-*.tgz' \) -mtime +"$KEEP_DAYS" -delete

latest=$(ls -t "$DEST"/db-*.dump 2>/dev/null | head -1)
[ -n "$latest" ] || { echo "$(date '+%F %T') ไม่พบไฟล์ backup ใน $DEST" >&2; exit 1; }
# backup ล่าสุดเก่าเกิน 2 วัน = cron บน VPS อาจหยุด · แจ้งใน log และ Notification Center
age_h=$(( ( $(date +%s) - $(stat -f %m "$latest") ) / 3600 ))
if [ "$age_h" -gt 48 ]; then
  msg="backup ล่าสุดของ Friday VPS เก่า ${age_h} ชั่วโมง"
  echo "$(date '+%F %T') เตือน: $msg" >&2
  osascript -e "display notification \"$msg\" with title \"Friday Manage\"" 2>/dev/null || true
fi
echo "$(date '+%F %T') ok: $(ls "$DEST" | wc -l | tr -d ' ') ไฟล์ · ล่าสุด $(basename "$latest") ($(du -h "$latest" | cut -f1))"
