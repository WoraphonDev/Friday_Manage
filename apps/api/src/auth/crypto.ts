// เครื่องมือเข้ารหัสของ A13 ใช้ node:crypto ล้วน (TOTP ตาม RFC 6238 เขียนเอง ไม่เพิ่ม dependency)
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { authSecret } from './auth.config.js';

/** กุญแจย่อยแยกตามงาน เพื่อไม่ให้ลายมือชื่อของงานหนึ่งเอาไปใช้กับอีกงานได้ */
const subkey = (purpose: string) => Buffer.from(hkdfSync('sha256', authSecret(), 'friday-auth', purpose, 32));

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** hash ของรหัสสั้น (6 หลัก, Backup code) · ใช้ HMAC เพราะรหัสสั้นเดาย้อนจาก sha256 ธรรมดาได้ */
export const hmacHex = (purpose: string, value: string) => createHmac('sha256', subkey(purpose)).update(value).digest('hex');

/** token แบบไม่เก็บในฐานข้อมูล (mfaToken, state ของ OAuth, คุกกี้จำอุปกรณ์) · payload อ่านได้ แต่แก้ไม่ได้ */
export function signToken(purpose: string, payload: Record<string, unknown>, ttlSeconds: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', subkey(`sig:${purpose}`)).update(body).digest('base64url')}`;
}

export function verifyToken<T extends Record<string, unknown>>(purpose: string, token: string | undefined): T | null {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', subkey(`sig:${purpose}`)).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

/** เข้ารหัส secret ของ 2FA ก่อนเก็บ (`*_enc` ตาม 01-entities) · AES-256-GCM */
export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', subkey('mfa-secret'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string) {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', subkey('mfa-secret'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238 · SHA-1, 6 หลัก, 30 วินาที แบบที่แอป Authenticator ทุกตัวรองรับ)
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP = 30;
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, step: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** คืน step ที่ตรง (ยอมเวลาคลาดเคลื่อน ±1 step) หรือ null */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 1000 / TOTP_STEP);
  let hit: number | null = null;
  // ตรวจครบทุก step เสมอเพื่อให้เวลาตอบเท่ากัน
  for (const s of [step - 1, step, step + 1]) if (safeEqual(totpAt(secretB32, s), code) && hit === null) hit = s;
  return hit;
}

export const otpauthUrl = (secretB32: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Friday Manage:${email}`)}?secret=${secretB32}&issuer=${encodeURIComponent('Friday Manage')}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;

// ---------------------------------------------------------------------------
// รหัสที่ผู้ใช้พิมพ์เอง
// ---------------------------------------------------------------------------
export const newCode6 = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// ตัด 0/o/1/l/i ที่อ่านสับสนออก
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newBackupCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeBackupCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');

// PKCE (RFC 7636 · S256)
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
