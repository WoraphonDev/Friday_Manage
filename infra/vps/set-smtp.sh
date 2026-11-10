#!/usr/bin/env bash
# ตั้ง SMTP ของ Gmail (App Password) ลง /opt/friday/.env · รหัสไม่ผ่าน sed (กันอักขระพิเศษ) และไม่แสดงบนจอ
set -euo pipefail
cd /opt/friday
read -r -p "Gmail: " u
u=$(printf %s "$u" | tr -d '[:space:]')
case "$u" in *@*.*) ;; *) echo "อีเมลไม่ถูกต้อง: $u" >&2; exit 1;; esac
read -r -s -p "App password (16 ตัว): " p; echo
# App Password ของ Google เป็นตัวอักษรล้วน 16 ตัว (หน้าเว็บแสดงเป็น 4 กลุ่มมีช่องว่าง) · ตัดอย่างอื่นทิ้ง
p=$(printf %s "$p" | tr -cd 'a-zA-Z')
if [ "${#p}" -ne 16 ]; then echo "รหัสต้องเป็นตัวอักษร 16 ตัว (ได้ ${#p} ตัว) · ลองคัดลอกใหม่" >&2; exit 1; fi
tmp=$(mktemp /opt/friday/.env.XXXX)
grep -vE '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|SMTP_SECURE|MAIL_FROM)=' .env >"$tmp"
{
  echo "SMTP_HOST=smtp.gmail.com"
  echo "SMTP_PORT=587"
  echo "SMTP_USER=$u"
  echo "SMTP_PASS=$p"
  echo "MAIL_FROM=Friday Manage <$u>"
} >>"$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
echo "บันทึกแล้ว"
