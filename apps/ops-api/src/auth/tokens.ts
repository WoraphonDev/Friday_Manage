import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const b64 = (b: Buffer) => b.toString('base64url');

/** โทเค็นเซ็นด้วย HMAC (ไม่เก็บฝั่งเซิร์ฟเวอร์): `<base64url(json)>.<base64url(hmac)>` แยก purpose กันสลับใช้ */
export function sign(purpose: string, payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()) {
  const body = b64(Buffer.from(JSON.stringify({ ...payload, p: purpose, exp: Math.floor(now / 1000) + ttlSeconds })));
  return `${body}.${b64(createHmac('sha256', config.secret).update(`${purpose}.${body}`).digest())}`;
}

export function verify<T extends Record<string, unknown>>(purpose: string, token: string | undefined, now = Date.now()): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', config.secret).update(`${purpose}.${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { p: string; exp: number };
    if (data.p !== purpose || data.exp * 1000 < now) return null;
    return data;
  } catch {
    return null;
  }
}
