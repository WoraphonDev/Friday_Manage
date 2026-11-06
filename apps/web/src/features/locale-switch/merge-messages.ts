// W21 · รวมข้อความแบบลึก: ค่าใน override แทนค่าใน base ทีละ key (array แทนทั้งก้อน)
export type Messages = { [key: string]: unknown };

const isObject = (value: unknown): value is Messages =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function mergeMessages(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] =
      isObject(current) && isObject(value) ? mergeMessages(current, value) : value;
  }
  return out;
}
