// W21 · ใช้ฝั่ง server เท่านั้น (next/headers + fs): หาภาษาของคำขอและโหลดข้อความของภาษานั้น
import { cookies, headers } from "next/headers";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type AppLocale } from "./locale";
import { mergeMessages, type Messages } from "./merge-messages";
import { resolveLocale } from "./resolve-locale";

/** ภาษาของคำขอนี้จาก cookie `NEXT_LOCALE` แล้วจึง Accept-Language */
export async function getRequestLocale(): Promise<AppLocale> {
  const [jar, list] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookie: jar.get(LOCALE_COOKIE)?.value,
    acceptLanguage: list.get("accept-language"),
  });
}

async function readNamespaces(directory: string): Promise<Messages> {
  const files = (await readdir(directory).catch(() => [] as string[])).filter(
    (name) => name.endsWith(".json"),
  );
  const entries = await Promise.all(
    files.map(async (name) => [
      name.slice(0, -5),
      JSON.parse(await readFile(join(directory, name), "utf8")) as Messages,
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * ข้อความทุก namespace ของภาษาที่เลือก · ภาษาอื่นวางทับภาษาไทย
 * เพื่อให้ข้อความที่ยังไม่แปลแสดงเป็นไทยแทนการแสดงรหัสข้อความ (Canvas R3)
 */
export async function loadMessages(
  locale: AppLocale,
  root = join(process.cwd(), "messages"),
): Promise<Messages> {
  const base = await readNamespaces(join(root, DEFAULT_LOCALE));
  if (locale === DEFAULT_LOCALE) return base;
  return mergeMessages(base, await readNamespaces(join(root, locale)));
}
