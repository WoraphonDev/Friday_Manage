import { z } from 'zod';

/**
 * ตำแหน่งของสมาชิกในโปรเจกต์ (project_members.positions) · คนหนึ่งมีได้หลายตำแหน่ง (ผู้ใช้ขอ 2026-11-13)
 * เก็บเป็นตัวย่อชุดเดียวกับ apps/web/src/lib/positions.ts · ค่าที่ไม่รู้จักเก็บตามที่พิมพ์ (ข้อมูลเดิมไม่หาย)
 */
const ALIASES: Record<string, string> = {
  pm: 'PM', 'project manager': 'PM',
  ba: 'BA', 'business analyst': 'BA',
  sa: 'SA', 'system analyst': 'SA',
  ux: 'UX', 'ux/ui': 'UX', 'ux/ui designer': 'UX',
  fe: 'FE', frontend: 'FE', 'frontend dev': 'FE', 'frontend developer': 'FE',
  be: 'BE', backend: 'BE', 'backend dev': 'BE', 'backend developer': 'BE',
  dev: 'DEV', developer: 'DEV',
  qa: 'QA', 'qa engineer': 'QA',
  devops: 'DEVOPS', 'dev ops': 'DEVOPS', 'devops engineer': 'DEVOPS',
};

export const PositionList = z.array(z.string().trim().min(1).max(60)).max(10);

/** ตัวย่อ ไม่ซ้ำ ตามลำดับที่ส่งมา */
export function normalizePositions(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    const code = ALIASES[v.toLowerCase()] ?? v;
    if (!out.some((x) => x.toLowerCase() === code.toLowerCase())) out.push(code);
  }
  return out;
}

/**
 * ค่าจากคำขอ: positions (ใหม่) หรือ position (เดิม ข้อความเดียว) · undefined = ไม่แก้
 * คืนทั้งรายการและข้อความรวม (position) ให้ที่แสดงผลเดิมใช้ต่อ
 */
export function positionsFrom(input: { positions?: string[] | null; position?: string | null }): { positions: string[]; position: string | null } | undefined {
  if (input.positions !== undefined) {
    const positions = normalizePositions(input.positions ?? []);
    return { positions, position: positions.length ? positions.join(', ') : null };
  }
  if (input.position !== undefined) {
    const positions = normalizePositions(input.position ? input.position.split(',') : []);
    return { positions, position: positions.length ? positions.join(', ') : null };
  }
  return undefined;
}
