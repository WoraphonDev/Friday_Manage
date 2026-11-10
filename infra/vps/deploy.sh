#!/usr/bin/env bash
# Build image linux/amd64 บน Mac แล้วส่งขึ้น VPS → migrate → เปิด service ใหม่ · รันจากราก checkout ที่จะ deploy
#   infra/vps/deploy.sh                 # ใช้ VPS_HOST จาก env หรือค่าเริ่มต้นด้านล่าง
#   VPS_HOST=root@203.0.113.10 VPS_KEY=~/.ssh/friday_vps infra/vps/deploy.sh
# เครื่อง VPS ไม่ build เอง (RAM 2 GB ไม่พอ build Next.js) · ข้อมูลใน volume ไม่ถูกแตะ
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@45.141.26.85}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/friday_vps}"
APP_DIR=/opt/friday
SSH=(ssh -i "$VPS_KEY" -o IdentitiesOnly=yes "$VPS_HOST")
# Docker Desktop: credential helper อยู่นอก PATH ของบาง shell
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

cd "$(git rev-parse --show-toplevel)"
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  if [ "${ALLOW_DIRTY:-}" != "1" ]; then
    echo "มีงานที่ยังไม่ commit · commit ก่อน หรือ ALLOW_DIRTY=1 (image จะติด -dirty)" >&2
    exit 1
  fi
  TAG="$TAG-dirty-$(date +%H%M%S)"
fi
echo "== deploy $(git branch --show-current) @ $TAG → $VPS_HOST"

build() { # build <ชื่อ> <Dockerfile> [build-arg...]
  local name=$1 file=$2; shift 2
  local args=()
  for a in "$@"; do args+=(--build-arg "$a"); done
  docker buildx build --platform linux/amd64 --load -f "$file" -t "friday-$name:$TAG" ${args[@]+"${args[@]}"} .
}
build api Dockerfile.api
build web Dockerfile.web API_ORIGIN=http://api:3001 "NEXT_PUBLIC_APP_VERSION=$TAG"
build ops-api Dockerfile.ops-api
build ops-web Dockerfile.ops-web OPS_API_ORIGIN=http://ops-api:4001

echo "== ส่ง image ขึ้นเครื่อง"
docker save "friday-api:$TAG" "friday-web:$TAG" "friday-ops-api:$TAG" "friday-ops-web:$TAG" | gzip -1 | "${SSH[@]}" 'gunzip | docker load'

echo "== ไฟล์ตั้งค่า"
"${SSH[@]}" "test -f $APP_DIR/.env" || { echo "ยังไม่มี $APP_DIR/.env · รัน setup-server.sh ก่อน" >&2; exit 1; }
scp -i "$VPS_KEY" -o IdentitiesOnly=yes -q infra/vps/compose.yml infra/vps/Caddyfile infra/vps/backup.sh "$VPS_HOST:$APP_DIR/"

echo "== migrate แล้วเปิด service"
"${SSH[@]}" bash -s -- "$TAG" <<'REMOTE'
set -euo pipefail
cd /opt/friday
chmod 700 backup.sh
prev=$(grep '^TAG=' .env | cut -d= -f2)
sed -i "s/^TAG=.*/TAG=$1/" .env
docker compose up -d postgres valkey
docker compose run --rm migrate
docker compose up -d --remove-orphans
for i in $(seq 1 40); do
  bad=$(docker compose ps --format '{{.Service}} {{.Health}}' | awk '$2!="" && $2!="healthy"' || true)
  [ -z "$bad" ] && break
  sleep 5
done
docker compose ps
if [ -n "${bad:-}" ]; then
  echo "service ยังไม่ healthy: $bad · รุ่นก่อนหน้าคือ $prev (ย้อนด้วย: sed TAG แล้ว docker compose up -d)" >&2
  exit 1
fi
# เก็บ image 2 รุ่นล่าสุดไว้ย้อนกลับ ลบที่เก่ากว่า
for repo in friday-api friday-web friday-ops-api friday-ops-web; do
  docker image ls "$repo" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | tail -n +3 | cut -f2 | xargs -r docker image rm >/dev/null || true
done
free -m
REMOTE

host=$("${SSH[@]}" "grep '^APP_HOST=' $APP_DIR/.env | cut -d= -f2")
ops=$("${SSH[@]}" "grep '^OPS_HOST=' $APP_DIR/.env | cut -d= -f2")
echo "== เสร็จ: https://$host · https://$ops (TAG $TAG)"
