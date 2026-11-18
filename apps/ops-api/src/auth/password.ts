// รหัสผ่าน + TOTP ของพนักงาน Friday (ทางเลือกแทน Security key) · ใช้ node:crypto ล้วน ไม่เพิ่ม dependency
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
/** ค่าตาม OWASP สำหรับ scrypt (N=2^17, r=8, p=1) */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export const LOCK_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined) {
  // ไม่มีรหัสผ่านก็ยังคำนวณ hash เพื่อให้เวลาตอบใกล้เคียงกัน (ไม่เปิดเผยว่าบัญชีนี้ตั้งรหัสผ่านไว้หรือไม่)
  const [alg, n, r, p, salt, key] = (stored ?? `scrypt$${SCRYPT.N}$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return !!stored && timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- เข้ารหัส secret ของ TOTP ก่อนเก็บ (AES-256-GCM)

const secretKey = () => Buffer.from(hkdfSync('sha256', config.secret, 'friday-ops', 'totp-secret', 32));

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string) {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- TOTP (RFC 6238 · SHA-1, 6 หลัก, 30 วินาที ที่แอป Authenticator ทุกตัวรองรับ)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP = 30;

function base32Encode(buf: Buffer) {
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

function base32Decode(s: string) {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, step: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** คืน step ที่ตรง (ยอมนาฬิกาคลาด ±1 step) หรือ null */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 1000 / TOTP_STEP);
  let hit: number | null = null;
  // ตรวจครบทุก step เสมอเพื่อให้เวลาตอบเท่ากัน
  for (const s of [step - 1, step, step + 1]) if (timingSafeEqual(Buffer.from(totpAt(secretB32, s)), Buffer.from(code)) && hit === null) hit = s;
  return hit;
}

export const otpauthUrl = (secretB32: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Friday Ops:${email}`)}?secret=${secretB32}&issuer=${encodeURIComponent('Friday Ops')}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
