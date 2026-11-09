#!/bin/sh
# ประกอบ URL ฐานข้อมูลจากค่าแยกที่ ECS ดึงจาก Secrets Manager (รหัสผ่านไม่มีอักขระพิเศษ จึงไม่ต้อง encode)
# ตั้ง DATABASE_*_URL มาเองได้ (เครื่องพัฒนา / Docker ในเครื่อง) สคริปต์นี้จะไม่ทับ
set -eu
if [ -n "${DB_HOST:-}" ]; then
  base="${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-friday}?sslmode=${DB_SSLMODE:-verify-full}"
  if [ -z "${DATABASE_APP_URL:-}" ] && [ -n "${DB_API_PASSWORD:-}" ]; then
    export DATABASE_APP_URL="postgres://friday_api:${DB_API_PASSWORD}@${base}"
  fi
  if [ -z "${DATABASE_SYSTEM_URL:-}" ] && [ -n "${DB_WORKER_PASSWORD:-}" ]; then
    export DATABASE_SYSTEM_URL="postgres://friday_worker:${DB_WORKER_PASSWORD}@${base}"
  fi
  if [ -z "${DATABASE_OWNER_URL:-}" ] && [ -n "${DB_OWNER_PASSWORD:-}" ]; then
    export DATABASE_OWNER_URL="postgres://${DB_OWNER_USER:-friday_owner}:${DB_OWNER_PASSWORD}@${base}"
  fi
fi
exec "$@"
