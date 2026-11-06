// W21 · ข้อความภาษาอังกฤษ: ทุก namespace ของไทยต้องมีคู่ EN ที่ key / placeholder ตรงกัน และไม่มีอักษรไทยหลง
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "messages");
const load = (locale: string, file: string) =>
  JSON.parse(readFileSync(join(root, locale, file), "utf8")) as Tree;
type Tree = { [key: string]: Tree | string };
const thFiles = readdirSync(join(root, "th")).filter((f) => f.endsWith(".json")).sort();
const enFiles = readdirSync(join(root, "en")).filter((f) => f.endsWith(".json")).sort();

// ข้อความ EN ที่ตั้งใจเป็นอักษรไทย: ชื่อภาษาให้คนไทยหาเจอในทุกภาษา (ตาม Canvas R3)
const THAI_ALLOWED = new Set(["ไทย", "ภาษาไทย", "พ.ศ.", "ไทย (TH)"]);

/** โครงสร้าง key: ใบไม้เป็น "string" · object เป็น key ที่เรียงแล้ว */
function shape(tree: Tree): unknown {
  return Object.fromEntries(
    Object.keys(tree)
      .sort()
      .map((k) => [k, typeof tree[k] === "string" ? "string" : shape(tree[k] as Tree)]),
  );
}

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "string" ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`),
  );
}

/**
 * ชื่อ argument และ rich tag ของข้อความ ICU · ไม่เทียบตัวเลือก plural
 * เพราะภาษาไทยไม่มีรูปพหูพจน์ EN จึงเปลี่ยน `{count}` เป็น plural ได้
 */
export function icuTokens(message: string): string[] {
  const out = new Set<string>();
  let i = 0;
  const parseText = (nested: boolean, plural: boolean) => {
    while (i < message.length) {
      const c = message[i];
      if (c === "'") {
        const next = message[i + 1];
        if (next === "'") i += 2;
        else if (next === "{" || next === "}" || (plural && next === "#")) {
          const end = message.indexOf("'", i + 1);
          i = end === -1 ? message.length : end + 1;
        } else i++;
      } else if (c === "{") {
        i++;
        parseArgument();
      } else if (c === "}") {
        if (nested) return;
        i++;
      } else if (c === "<") {
        const m = /^<\/?([A-Za-z][\w-]*)\s*\/?>/.exec(message.slice(i));
        if (m) {
          out.add(`<${m[1]}>`);
          i += m[0].length;
        } else i++;
      } else i++;
    }
  };
  const readUntil = (stops: string) => {
    const start = i;
    while (i < message.length && !stops.includes(message[i])) i++;
    return message.slice(start, i).trim();
  };
  const parseArgument = () => {
    const name = readUntil(",}");
    out.add(`{${name}}`);
    if (message[i] === "}") {
      i++;
      return;
    }
    i++;
    const type = readUntil(",}");
    if (message[i] === "}") {
      i++;
      return;
    }
    i++;
    if (type === "plural" || type === "select" || type === "selectordinal") {
      while (i < message.length && message[i] !== "}") {
        if (message[i] === "{") {
          i++;
          parseText(true, type !== "select");
          i++;
        } else i++;
      }
      i++;
    } else {
      readUntil("}");
      i++;
    }
  };
  parseText(false, false);
  return [...out].sort();
}

describe("ข้อความภาษาอังกฤษ (W21)", () => {
  it("ทุกไฟล์ภาษาไทยมีคู่ภาษาอังกฤษ และไม่มีไฟล์ EN เกิน", () => {
    expect(enFiles).toEqual(thFiles);
  });

  it.each(thFiles)("%s: key ตรงกันทุกระดับ", (file) => {
    expect(shape(load("en", file))).toEqual(shape(load("th", file)));
  });

  it.each(thFiles)("%s: placeholder และ rich tag ตรงกัน", (file) => {
    const en = new Map(leaves(load("en", file)));
    const mismatched = leaves(load("th", file))
      .filter(([key, th]) => en.has(key) && icuTokens(th).join() !== icuTokens(en.get(key)!).join())
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it.each(thFiles)("%s: ไม่มีอักษรไทยหลงใน EN", (file) => {
    const thai = leaves(load("en", file))
      .filter(([, v]) => /[฀-๿]/.test(v.replaceAll("฿", "")) && !THAI_ALLOWED.has(v))
      .map(([key, v]) => `${key}: ${v}`);
    expect(thai).toEqual([]);
  });

  it.each(thFiles)("%s: ข้อความ EN ทุกตัว format ได้ (ICU ถูกต้อง)", (file) => {
    const messages = load("en", file);
    const errors: string[] = [];
    const t = createTranslator({
      locale: "en",
      messages,
      onError: (error) => errors.push(error.message),
      getMessageFallback: ({ key }) => key,
    });
    for (const [key, value] of leaves(messages)) {
      const values = Object.fromEntries(
        icuTokens(value).map((token) =>
          token.startsWith("<")
            ? [token.slice(1, -1), (chunks: unknown) => chunks]
            : [token.slice(1, -1), 1],
        ),
      );
      // rich tag ต้องใช้ t.rich · ข้อความธรรมดาใช้ t ปกติ
      if (Object.values(values).some((v) => typeof v === "function"))
        t.rich(key as never, values as never);
      else t(key as never, values as never);
    }
    expect(errors).toEqual([]);
  });

  it("icuTokens อ่าน argument, plural และ tag ได้", () => {
    expect(icuTokens("{count, plural, one {# task} other {# tasks}} in <b>{name}</b>")).toEqual(
      ["<b>", "{count}", "{name}"],
    );
    expect(icuTokens("don't '{literal}' {a}")).toEqual(["{a}"]);
  });
});
