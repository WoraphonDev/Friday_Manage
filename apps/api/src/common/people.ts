import { schema, type Tx } from '@friday/db';
import { inArray } from 'drizzle-orm';

/** คนในงานตามธรรมเนียม API: { id, displayName, initials, avatarUrl } (03-api › ธรรมเนียม) */
export interface Person {
  id: string;
  displayName: string;
  initials: string;
  avatarUrl: string | null;
}

/** "Mick" → "MI" · "Donut Sweet" → "DS" · ภาษาไทยใช้ตัวแรก */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return [...(words[0] ?? '?')].slice(0, 2).join('').toUpperCase();
}

/** โหลดข้อมูลคนตาม id (RLS เห็นเฉพาะคนใน Workspace ปัจจุบัน) */
export async function loadPeople(tx: Tx, ids: Iterable<string | null | undefined>) {
  const want = [...new Set([...ids].filter((x): x is string => !!x))];
  const map = new Map<string, Person>();
  if (!want.length) return map;
  const rows = await tx
    .select({ id: schema.users.id, displayName: schema.users.displayName, avatarUrl: schema.users.avatarUrl })
    .from(schema.users)
    .where(inArray(schema.users.id, want));
  for (const r of rows) map.set(r.id, { ...r, initials: initials(r.displayName) });
  return map;
}
