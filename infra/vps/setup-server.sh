#!/usr/bin/env bash
# ตั้งเครื่อง Ubuntu 22.04/24.04 ใหม่ให้พร้อมรัน Friday Manage · รันซ้ำได้ (ไม่ทับ .env ที่มีอยู่)
# ใช้จาก Mac: ssh root@<ip> 'bash -s' < infra/vps/setup-server.sh <ip>
# ต้องเข้าด้วย SSH key ได้แล้วก่อนรัน เพราะสคริปต์ปิดการเข้าด้วยรหัสผ่าน
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

IP="${1:?ใส่ IP ของเครื่อง เช่น 203.0.113.10}"
APP_DIR=/opt/friday

if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "ยังไม่มี SSH key ใน /root/.ssh/authorized_keys · หยุดก่อนปิดการเข้าด้วยรหัสผ่าน" >&2
  exit 1
fi

echo "== แพ็กเกจและอัปเดตความปลอดภัย"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg ufw fail2ban unattended-upgrades openssl
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== SSH: เข้าด้วย key เท่านั้น"
cat >/etc/ssh/sshd_config.d/10-friday.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh

echo "== firewall: 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
systemctl enable --now fail2ban

echo "== swap 2 GB (RAM 2 GB ไม่พอสำหรับช่วงที่ทุก service เริ่มพร้อมกัน)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
echo 'vm.swappiness=10' >/etc/sysctl.d/99-friday.conf

echo "== Docker (repo ทางการ)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "== $APP_DIR/.env"
mkdir -p "$APP_DIR/backups"
chmod 700 "$APP_DIR" "$APP_DIR/backups"
if [ ! -f "$APP_DIR/.env" ]; then
  rand() { openssl rand -hex 32; }
  host="$(echo "$IP" | tr . -).sslip.io"
  cat >"$APP_DIR/.env" <<EOF
APP_HOST=app.$host
OPS_HOST=ops.$host
TAG=
DB_OWNER_PASSWORD=$(rand)
DB_API_PASSWORD=$(rand)
DB_WORKER_PASSWORD=$(rand)
AUTH_SECRET=$(rand)
OPS_AUTH_SECRET=$(rand)
STRIPE_WEBHOOK_SECRET=$(rand)
ETAX_WEBHOOK_SECRET=$(rand)
EMAIL_FEEDBACK_TOKEN=$(rand)
PAYMENT_GATEWAY=fake
STRIPE_SECRET_KEY=
VAT_REGISTERED=false
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
OPS_JOBS=on
OPS_ACCOUNTING_EMAIL=
SENTRY_DSN=
SENTRY_ENVIRONMENT=staging
EOF
  chmod 600 "$APP_DIR/.env"
  echo "สร้าง .env แล้ว (secret สุ่มใหม่)"
else
  echo "มี .env อยู่แล้ว ไม่แตะ"
fi

echo "== backup รายวัน 03:15 (เวลาเครื่อง)"
timedatectl set-timezone Asia/Bangkok
cat >/etc/cron.d/friday-backup <<EOF
15 3 * * * root $APP_DIR/backup.sh >>/var/log/friday-backup.log 2>&1
EOF

echo "เสร็จ · $(docker --version) · $(docker compose version)"
free -m
