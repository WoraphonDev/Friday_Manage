import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { authSecret } from '../auth/auth.config.js';

// กุญแจย่อยแยกจาก 2FA และ token อื่น เพื่อไม่ให้ ciphertext ของงานหนึ่งถูกนำไปถอดด้วยอีกงาน
const key = () => Buffer.from(hkdfSync('sha256', authSecret(), 'friday-channels', 'channel-secret', 32));

/** เข้ารหัส secret ของช่องทาง (URL Webhook, รหัสผ่าน SMTP, ฯลฯ) ก่อนเก็บ · AES-256-GCM */
export function sealSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string) {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** 4 ตัวท้ายสำหรับแสดงในหน้าตั้งค่า · ค่าเต็มไม่ถูกส่งกลับอีก */
export const last4 = (plain: string) => plain.slice(-4);
