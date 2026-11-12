/**
 * Mention ในคอมเมนต์: API เก็บแบบคงที่ `@[ชื่อ](userId)` เพื่อไม่สับสนเมื่อชื่อซ้ำหรือเปลี่ยนชื่อ
 * แต่ช่องพิมพ์ต้องแสดงแค่ `@ชื่อ` (ผู้ใช้ทักว่ารหัสติดมาในช่อง 2026-11-12) จึงแปลงไปกลับตรงนี้
 */
export type MentionPicks = Map<string, string>;

const STORED = /@\[([^\]\n]+)\]\(([0-9a-f-]{36})\)/gi;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ข้อความที่เก็บ → ข้อความในช่องพิมพ์ + ชื่อที่เลือกไว้ (ใช้ตอนเปิดแก้คอมเมนต์) */
export function toDisplay(stored: string): { text: string; picks: MentionPicks } {
  const picks: MentionPicks = new Map();
  const text = stored.replace(STORED, (_, name: string, id: string) => { picks.set(name, id); return `@${name}`; });
  return { text, picks };
}

/** ข้อความในช่องพิมพ์ → ข้อความที่ส่ง API · ชื่อยาวก่อน เพื่อไม่ให้ "@Pond" กิน "@Pond K." · ขอบหน้าใช้กติกาเดียวกับ API */
export function toStored(text: string, picks: MentionPicks): string {
  let out = text;
  for (const [name, id] of [...picks].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_.+\\-])@${escape(name)}(?![\\p{L}\\p{M}\\p{N}_\\-]|\\]\\()`, 'gu'), `@[${name}](${id})`);
  }
  return out;
}

/** แสดงผล: ให้ "@" อยู่ในป้ายชื่อเดียวกัน ไม่แยกเป็น "@ ชื่อ" */
export const forDisplay = (stored: string) => stored.replace(STORED, (_, name: string, id: string) => `[@${name}](${id})`);
