#!/usr/bin/env bash
# Valkey สำหรับเครื่องที่ไม่มี Docker และไม่มี root (Codex cloud) · ได้ผลเหมือน `docker compose up -d valkey`: พอร์ต 63799
# ไม่จำเป็นต่อ test: API ใช้ QUEUE_MODE=inline เมื่อไม่มี VALKEY_URL · ใช้เมื่ออยากรัน Worker จริงหรือ test กับ Valkey
# ใช้ valkey-server ที่มีในเครื่องถ้ามี ไม่งั้น build จาก source (ต้องมี make + cc) เก็บใน .cache/valkey (อยู่ใน .gitignore)
# รันซ้ำได้: build ครั้งแรกครั้งเดียว ครั้งต่อไปแค่เปิดเซิร์ฟเวอร์ถ้ายังไม่เปิด
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=63799
VERSION=9.0.7
ROOT="$PWD/.cache/valkey"
SRC="$ROOT/valkey-$VERSION"
DATA="$ROOT/data"

# 1. binary
if command -v valkey-server >/dev/null; then
  SERVER="$(command -v valkey-server)"
elif [ -x "$SRC/src/valkey-server" ]; then
  SERVER="$SRC/src/valkey-server"
else
  for tool in make cc curl tar; do
    command -v "$tool" >/dev/null || { echo "ต้องมี $tool เพื่อ build Valkey · หรือใช้ docker compose up -d valkey" >&2; exit 1; }
  done
  mkdir -p "$ROOT"
  curl -fsSL "https://github.com/valkey-io/valkey/archive/refs/tags/$VERSION.tar.gz" | tar xz -C "$ROOT"
  JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  # ไม่ใช้ TLS และ systemd เพื่อไม่ต้องติดตั้ง library เพิ่ม
  make -C "$SRC" -j"$JOBS" BUILD_TLS=no USE_SYSTEMD=no >"$ROOT/build.log" 2>&1 || { echo "build Valkey ไม่ผ่าน ดู $ROOT/build.log" >&2; exit 1; }
  SERVER="$SRC/src/valkey-server"
fi

# 2. เปิดเซิร์ฟเวอร์ (ตรวจด้วย PING ผ่าน /dev/tcp ของ bash ไม่ต้องพึ่ง valkey-cli)
ping_valkey() {
  # ครอบด้วย { } เพื่อให้ 2>/dev/null มีผลแค่ตอนเชื่อมต่อ ไม่ปิด stderr ทั้งสคริปต์
  { exec 3<>"/dev/tcp/127.0.0.1/$PORT"; } 2>/dev/null || return 1
  printf 'PING\r\n' >&3
  local reply
  read -r -t 2 reply <&3 || true
  exec 3<&- 3>&-
  [[ "$reply" == +PONG* ]]
}

if ! ping_valkey; then
  mkdir -p "$DATA"
  # noeviction ตามที่ BullMQ แนะนำ (ห้ามทิ้ง key ของคิวเมื่อหน่วยความจำเต็ม) · dev ไม่ต้องเก็บลงดิสก์
  "$SERVER" --port "$PORT" --bind 127.0.0.1 --daemonize yes --dir "$DATA" \
    --pidfile "$ROOT/valkey.pid" --logfile "$ROOT/server.log" \
    --maxmemory-policy noeviction --save '' --appendonly no
  for _ in $(seq 1 50); do ping_valkey && break; sleep 0.1; done
  ping_valkey || { echo "เปิด Valkey ไม่สำเร็จ ดู $ROOT/server.log" >&2; exit 1; }
fi

echo "Valkey พร้อมที่ localhost:$PORT · ตั้ง VALKEY_URL=redis://localhost:$PORT (log: .cache/valkey/server.log · หยุด: kill \$(cat .cache/valkey/valkey.pid))"
