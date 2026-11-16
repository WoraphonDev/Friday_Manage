#!/usr/bin/env bash
# ตั้งกุญแจ Stripe ลง /opt/friday/.env · กุญแจลับไม่แสดงบนจอและไม่ผ่าน sed (กันอักขระพิเศษ)
# รันจาก Mac: ssh -t -i ~/.ssh/friday_vps root@<VPS> /opt/friday/set-stripe.sh
# หลังตั้งแล้ว: รัน infra/vps/deploy.sh อีกครั้ง (เว็บต้อง build ใหม่เพื่อฝังกุญแจสาธารณะ · API อ่านกุญแจลับตอนเริ่ม)
set -euo pipefail
cd /opt/friday
echo "กุญแจจาก Stripe Dashboard › Developers › API keys (โหมดทดสอบ = pk_test_ / sk_test_)"
read -r -p "Publishable key (pk_...): " pk
pk=$(printf %s "$pk" | tr -d '[:space:]')
case "$pk" in pk_test_*|pk_live_*) ;; *) echo "ต้องขึ้นต้นด้วย pk_test_ หรือ pk_live_" >&2; exit 1;; esac
read -r -s -p "Secret key (sk_... หรือ rk_...): " sk; echo
sk=$(printf %s "$sk" | tr -d '[:space:]')
case "$sk" in sk_test_*|sk_live_*|rk_test_*|rk_live_*) ;; *) echo "ต้องขึ้นต้นด้วย sk_ หรือ rk_ (restricted key)" >&2; exit 1;; esac
# โหมดต้องตรงกัน ไม่งั้นช่องบัตรสร้างรายการไม่ได้
if [ "${pk#pk_test_}" != "$pk" ] && [ "${sk#*_test_}" = "$sk" ]; then echo "pk เป็นโหมดทดสอบ แต่ secret key เป็นโหมดจริง" >&2; exit 1; fi
if [ "${pk#pk_live_}" != "$pk" ] && [ "${sk#*_live_}" = "$sk" ]; then echo "pk เป็นโหมดจริง แต่ secret key เป็นโหมดทดสอบ" >&2; exit 1; fi
echo "Webhook: Stripe Dashboard › Developers › Webhooks › Add endpoint"
echo "  URL: https://$(grep '^APP_HOST=' .env | cut -d= -f2)/api/v1/hooks/stripe"
echo "  Events: payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled"
read -r -s -p "Signing secret (whsec_...): " wh; echo
wh=$(printf %s "$wh" | tr -d '[:space:]')
case "$wh" in whsec_*) ;; *) echo "ต้องขึ้นต้นด้วย whsec_" >&2; exit 1;; esac
tmp=$(mktemp /opt/friday/.env.XXXX)
grep -vE '^(STRIPE_PUBLISHABLE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)=' .env >"$tmp"
{
  echo "STRIPE_PUBLISHABLE_KEY=$pk"
  echo "STRIPE_SECRET_KEY=$sk"
  echo "STRIPE_WEBHOOK_SECRET=$wh"
} >>"$tmp"
chmod 600 "$tmp"
cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
mv "$tmp" .env
case "$pk" in pk_live_*) echo "⚠ ตั้งเป็นโหมดจริง: บัตรจะถูกตัดเงินจริง";; esac
echo "บันทึกแล้ว · ต่อไปรัน infra/vps/deploy.sh จาก Mac"
