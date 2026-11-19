import { isIP } from 'node:net';
import type { Db, Tx } from '@friday/db';
import { sql } from 'drizzle-orm';

/** IPv4 ที่มาในรูป IPv6 (::ffff:1.2.3.4) แปลงเป็น IPv4 ให้ตรงกับรายชื่อที่บล็อกและสถิติการสมัคร · ค่าแปลก = null */
export function clientIp(ip?: string | null) {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return isIP(v) ? v : null;
}

const active = sql`removed_at is null and (expires_at is null or expires_at > now())`;

async function any(db: Db | Tx, q: ReturnType<typeof sql>) {
  const r = await db.execute(q);
  return (((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as unknown[]).length > 0;
}

/**
 * รายชื่อที่ทีม Friday บล็อก (O50 · abuse_blocks): โดเมนอีเมล และ IP / ช่วง IP
 * อ่านด้วย SYSTEM_DB เพราะเป็นตารางของทีม Friday (friday_app อ่านไม่ได้) และตอนสมัครยังไม่มี Workspace ให้ RLS อ้างถึง
 */
export async function signupBlocked(db: Db | Tx, email: string, ip?: string | null) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const addr = clientIp(ip);
  return any(
    db,
    sql`select 1 from abuse_blocks where ${active} and (
      (kind = 'email_domain' and lower(value) = ${domain})
      ${addr ? sql`or (kind = 'ip' and ${addr}::inet <<= value::inet)` : sql``}
    ) limit 1`,
  );
}

/** slug ที่ถูกบล็อก (เช่น ชื่อหลอกลวง) ตอบเหมือน slug ที่มีคนใช้แล้ว ไม่บอกว่าถูกบล็อก */
export async function slugBlocked(db: Db | Tx, slug: string) {
  return any(db, sql`select 1 from abuse_blocks where ${active} and kind = 'workspace_slug' and lower(value) = ${slug.toLowerCase()} limit 1`);
}

export const SIGNUP_BLOCKED = 'สมัครด้วยอีเมลหรือเครือข่ายนี้ไม่ได้ · ถ้าคิดว่าเป็นความผิดพลาด ติดต่อทีม Friday';
