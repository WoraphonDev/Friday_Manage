#!/usr/bin/env bash
# ฐานข้อมูลสำหรับเครื่องที่ไม่มี Docker (Codex cloud, CI) · Ubuntu / Debian เท่านั้น
# ได้ผลเหมือน `pnpm db:up`: PostgreSQL 18 พอร์ต 54329 · ฐาน friday · เจ้าของ friday_owner (superuser)
# แล้วรัน migration และสร้างบัญชี friday_api / friday_worker ให้ (ค่าตาม .env.example)
set -euo pipefail
PORT=54329
cd "$(dirname "$0")/.."

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
as_pg() { if [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }

if [ ! -x /usr/lib/postgresql/18/bin/postgres ]; then
  as_root apt-get update -qq
  as_root apt-get install -y -qq postgresql-common ca-certificates
  as_root /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  as_root apt-get install -y -qq postgresql-18
fi

if ! pg_lsclusters --no-header | awk '{print $1, $2}' | grep -qx '18 friday'; then
  as_root pg_createcluster 18 friday --port "$PORT"
fi
as_root pg_ctlcluster 18 friday start 2>/dev/null || true

psql_pg() { as_pg psql -p "$PORT" -v ON_ERROR_STOP=1 -tAc "$1"; }
[ "$(psql_pg "SELECT 1 FROM pg_roles WHERE rolname = 'friday_owner'")" = "1" ] ||
  psql_pg "CREATE ROLE friday_owner LOGIN SUPERUSER PASSWORD 'friday_owner_dev'"
[ "$(psql_pg "SELECT 1 FROM pg_database WHERE datname = 'friday'")" = "1" ] ||
  psql_pg "CREATE DATABASE friday OWNER friday_owner"

pnpm db:migrate
pnpm db:dev-roles
echo "PostgreSQL 18 พร้อมที่ localhost:$PORT"
