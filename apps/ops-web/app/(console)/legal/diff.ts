export type DiffLine = { kind: "same" | "add" | "del"; text: string } | { kind: "skip"; count: number };

/** จำกัดขนาดตาราง LCS (บรรทัดเก่า × ใหม่) ไม่ให้หน้าค้างกับเอกสารยาวมาก */
const MAX_CELLS = 4_000_000;

/**
 * เทียบทีละบรรทัดด้วย LCS · ย่อช่วงที่เหมือนเดิมให้เหลือบรรทัดรอบ ๆ ส่วนที่เปลี่ยน
 * คืน null เมื่อเอกสารยาวเกินจะเทียบ
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] | null {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > MAX_CELLS) return null;
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const raw: { kind: "same" | "add" | "del"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (raw.push({ kind: "same", text: a[i]! }), i++, j++);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) raw.push({ kind: "del", text: a[i++]! });
    else raw.push({ kind: "add", text: b[j++]! });
  }
  while (i < n) raw.push({ kind: "del", text: a[i++]! });
  while (j < m) raw.push({ kind: "add", text: b[j++]! });
  // เก็บบรรทัดเหมือนเดิมเฉพาะที่อยู่ใกล้ส่วนที่เปลี่ยน
  const near = raw.map((_, k) => raw.slice(Math.max(0, k - context), k + context + 1).some((x) => x.kind !== "same"));
  const out: DiffLine[] = [];
  let skipped = 0;
  raw.forEach((line, k) => {
    if (line.kind !== "same" || near[k]) {
      if (skipped) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
