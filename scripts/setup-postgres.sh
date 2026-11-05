#!/usr/bin/env bash
# PostgreSQL 18 สำหรับเครื่องที่ไม่มี Docker และไม่มี root (Codex cloud) · Linux x64 / arm64
# ได้ผลเหมือน `pnpm db:up`: พอร์ต 54329 · ฐาน friday · เจ้าของ friday_owner (superuser) · ค่าตาม .env.example
# ใช้ binary ของ PostgreSQL จาก npm (@embedded-postgres) เก็บใน .cache/postgres ของ repo (อยู่ใน .gitignore)
# รันซ้ำได้: ติดตั้งครั้งแรกครั้งเดียว ครั้งต่อไปแค่เปิดเซิร์ฟเวอร์ถ้ายังไม่เปิด แล้วรัน migration
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=54329
PG_PACKAGE_VERSION=18.6.0-beta.19
ROOT="$PWD/.cache/postgres"
PKG="$ROOT/package"
BIN="$PKG/native/bin"
DATA="$ROOT/data"
export LD_LIBRARY_PATH="$PKG/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if [ "$(id -u)" -eq 0 ]; then
  echo "PostgreSQL ไม่ยอมรันด้วย root · รันสคริปต์นี้ด้วยผู้ใช้ทั่วไป หรือใช้ pnpm db:up (Docker)" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "ไม่รองรับ CPU $(uname -m)" >&2; exit 1 ;;
esac

# 1. binary
if [ ! -x "$BIN/postgres" ]; then
  mkdir -p "$ROOT"
  (cd "$ROOT" && npm pack "@embedded-postgres/linux-$ARCH@$PG_PACKAGE_VERSION" --silent >/dev/null && tar xzf embedded-postgres-linux-*.tgz && rm embedded-postgres-linux-*.tgz)
  node "$PKG/scripts/hydrate-symlinks.js"
fi

# 2. ฐานข้อมูล (initdb ตั้ง friday_owner เป็น superuser ให้เลย)
if [ ! -f "$DATA/PG_VERSION" ]; then
  pw="$(mktemp)"
  printf 'friday_owner_dev' >"$pw"
  "$BIN/initdb" -D "$DATA" -U friday_owner --pwfile="$pw" -A scram-sha-256 -E UTF8 \
    --locale=C --locale-provider=builtin --builtin-locale=C.UTF-8 >/dev/null
  rm -f "$pw"
  echo "CREATE DATABASE friday OWNER friday_owner;" | "$BIN/postgres" --single -D "$DATA" postgres >/dev/null
fi

# 3. เปิดเซิร์ฟเวอร์ (socket อยู่ใน .cache เพราะ /var/run/postgresql เขียนไม่ได้)
if ! "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  "$BIN/pg_ctl" -D "$DATA" -l "$ROOT/server.log" -o "-p $PORT -k $ROOT -c listen_addresses=localhost" -w start >/dev/null
fi

# 4. migration + บัญชี friday_api / friday_worker
PNPM="pnpm"
command -v pnpm >/dev/null || PNPM="corepack pnpm"
$PNPM db:migrate >/dev/null
$PNPM db:dev-roles
echo "PostgreSQL 18 พร้อมที่ localhost:$PORT (log: .cache/postgres/server.log · หยุด: $BIN/pg_ctl -D $DATA stop)"
