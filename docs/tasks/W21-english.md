# W21 · ภาษาอังกฤษ (EN)

| | |
|---|---|
| Wave | 3 · ปิดท้าย |
| รอ merge | W00, ทุกงาน W |
| Lane (แก้ได้เฉพาะ) | `apps/web/messages/en/**` · `apps/web/src/features/locale-switch/**` |
| หน้าจอ | R3 (`design/canvas/Localization.dc.html`) |
| สเปก | 03-api › 2 หน้าจอ → API (แถวของหน้าที่ระบุ) |

อ่าน [README](README.md) ก่อนเริ่ม: กติกา lane, ไฟล์กลาง และวิธีส่งงาน

## ทำอะไร

- แปลทุก namespace เป็น `messages/en/*.json` · ตัวสลับภาษา · ปี ค.ศ. เป็นค่าเริ่มต้นของ EN

## เสร็จเมื่อ

- [ ] หน้าตรงกับไฟล์ Canvas ที่ 1440 px และ 390 px (เทียบภาพ) · ใช้ UI kit ของ W00
- [ ] ครบทุกสถานะตาม M1: กำลังโหลด, ว่าง, Error พร้อม requestId, 403 / ไม่มีสิทธิ์ (ซ่อนปุ่มตาม `my-permissions`)
- [x] component test ด้วย MSW ครอบคลุมทุกข้อใน "ทำอะไร" · `pnpm --filter @friday/web typecheck test build` ผ่าน
- [ ] ข้อความทั้งหมดอยู่ใน namespace ของงานนี้

## บันทึกผล

<!-- ผู้ทำงานเขียนตอนส่งงาน: endpoint / หน้าที่เพิ่ม, สิ่งที่ต่างจากสเปกหรือหน้าจอ, คำตัดสินที่เลือกเอง, คำขอนอก lane, คำถามที่ค้าง -->

### สิ่งที่ทำ

- `messages/en/*.json` ครบ 20 ไฟล์ คู่กับ `messages/th/*.json` ทุกไฟล์ · key ตรงกันทุกระดับ (รวม array ใน `saas-pages`, `calendar`) · ชื่อ placeholder ICU และ rich tag (`<b>`, `<terms>`, `<privacy>`, `<dpa>`, `<login>`) ตรงกันทุกข้อความ
- ข้อความที่มีจำนวนใช้ `{count, plural, one {…} other {…}}` ใน EN (ไทยไม่มีรูปพหูพจน์จึงเป็น `{count}` ธรรมดา) · ในแต่ละ branch ใช้ `{count}` แทน `#` เพื่อให้แสดงค่าที่ส่งมาตรงตัว (บางหน้าส่งตัวเลขที่ format แล้วเป็น string)
- ศัพท์: คงคำสากลของทีม Dev (Sprint, Backlog, Story, Bug, Commit, PR, Man-Day, Workload, Baseline, Go-live, Due, WIP limit, Module) · ข้อความกฎหมาย/ราคาแปลตรงความหมาย ไม่เพิ่มข้อมูล · "50 ทวิ" → "50 Tawi", "{amount} บาท" → `฿{amount}` ตาม Canvas (`฿1,234.50 (THB)`), "ธปท." → "Bank of Thailand" / "BOT", "พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562" → "Personal Data Protection Act B.E. 2562 (2019)"
- อักษรไทยที่ตั้งใจคงไว้ใน EN: `profile.personal.localeTh` = "ไทย" (ชื่อภาษาเป็นภาษาตัวเอง ตาม Canvas R3 ที่แสดง "ไทย / English" ในทั้งสองภาษา)
- `src/features/locale-switch/`
  - `locale.ts`: `LOCALES`, `LOCALE_COOKIE = "NEXT_LOCALE"` (ชื่อเดียวกับที่ next-intl ใช้), `defaultYearFormat` (th → BE, en → CE), `effectiveYearFormat`, `dateLocale(locale, year)` (`en-US-u-ca-gregory` → "Nov 5, 2026"), `LANGUAGE_NAMES`
  - `resolve-locale.ts`: `resolveLocale({ userLocale, cookie, acceptLanguage })` ลำดับ บัญชี → cookie → Accept-Language (อ่านค่า q, en-GB → en) → "th" · `parseAcceptLanguage`
  - `server.ts`: `getRequestLocale()` (อ่าน `cookies()` / `headers()` ของ next/headers) และ `loadMessages(locale)` โหลดทุก namespace โดยวาง EN ทับไทย (`merge-messages.ts`) ข้อความที่ยังไม่แปลจึงแสดงเป็นไทย ไม่แสดงรหัสข้อความ
  - `LocaleSwitch`: segmented "ไทย | English" (+ "พ.ศ. | ค.ศ." เมื่อ `showYearFormat`) ตาม Canvas · ล็อกอินแล้ว (`signedIn`) ส่ง `PATCH /me` เฉพาะค่าที่ต่างจากบัญชี (`locale`, `yearFormat`) แล้วอัปเดต cache `queryKeys.me` · เมื่อภาษาเปลี่ยน เขียน cookie `NEXT_LOCALE`, ตั้ง `<html lang>` และ `router.refresh()` · PATCH ไม่สำเร็จแสดง toast ข้อความ error ของ API และไม่เปลี่ยน cookie
  - `LocaleSync({ me })`: วางใน shell หลังโหลด GET /me · ถ้าภาษาในบัญชีต่างจาก cookie / หน้าปัจจุบัน (เปลี่ยนจากอีกเครื่อง หรือจากหน้า Profile) เขียน cookie แล้ว refresh
- Test: `src/lib/locale-en.test.ts` (ทุกไฟล์ th มีคู่ en และไม่มีไฟล์เกิน · โครงสร้าง key ลึกตรงกัน · ชื่อ argument / rich tag ICU ตรงกัน · ไม่มีอักษรไทยหลง ยกเว้นรายการที่ตั้งใจ · ทุกข้อความ EN format ได้จริงด้วย `createTranslator` ของ next-intl) และ `src/lib/locale-switch.test.tsx` (resolveLocale / Accept-Language, ปีเริ่มต้น + รูปแบบวันที่ EN, getRequestLocale กับ mock next/headers, loadMessages + fallback, LocaleSwitch หน้าสาธารณะ / ล็อกอิน / เปลี่ยนปีใน EN / PATCH ล้มเหลว ด้วย MSW, LocaleSync)

### คำตัดสินที่เลือกเอง

- เปลี่ยนภาษาแล้วตั้งรูปแบบปีเป็นค่าเริ่มต้นของภาษานั้นด้วย (ตาม Canvas: `setEn` → ค.ศ., `setTh` → พ.ศ.) · เปลี่ยนปีเองภายหลังได้ที่ตัวสลับ (`showYearFormat`) หรือ Profile
- หน้าสาธารณะไม่มีรูปแบบปีที่บันทึก จึงใช้ `effectiveYearFormat(locale)` (EN = ค.ศ.) และไม่แสดงตัวเลือกปี
- Canvas เขียนว่า "ข้อความที่ขาด แสดงเป็นภาษาอังกฤษแทน ไม่แสดงรหัสข้อความ" · ภาษาที่มีคือ TH (ต้นฉบับ) กับ EN จึงทำเป็น "ขาดใน EN → แสดงไทย" ผ่าน `loadMessages` และกันไม่ให้ขาดด้วย test ที่บังคับ key ครบ
- ข้อความของตัวสลับเอง ("ภาษาของระบบ" / "Language", "พ.ศ." / "B.E." ฯลฯ) อยู่ใน `features/locale-switch/labels.ts` แยกตามภาษา เพราะ lane นี้ไม่มี `messages/th` ของตัวเอง และตัวสลับต้องแสดงได้ทุกหน้า / ทุก test โดยไม่ต้องโหลด namespace เพิ่ม · จึงยังไม่ติ๊กข้อ "ข้อความทั้งหมดอยู่ใน namespace" · ย้ายเป็น `messages/{th,en}/locale-switch.json` ได้ถ้าเปิด lane ให้
- ชื่อภาษาไม่แปล ("ไทย", "English")

### คำขอนอก lane

ไฟล์กลางที่ต้องแก้เพื่อให้ EN ใช้งานจริง (ยังไม่ได้แก้เอง) · diff ตัวอย่าง:

1. `apps/web/src/i18n/request.ts` (W00) เลิกล็อก "th"

```diff
-import { getRequestConfig } from "next-intl/server";
-import { readdir, readFile } from "node:fs/promises";
-import { join } from "node:path";
-
-export default getRequestConfig(async () => {
-  const directory = join(process.cwd(), "messages", "th");
-  … (อ่านทุกไฟล์ใน messages/th)
-  return { locale: "th", messages: Object.fromEntries(entries), timeZone: "Asia/Bangkok" };
-});
+import { getRequestConfig } from "next-intl/server";
+import { getRequestLocale, loadMessages } from "@/features/locale-switch/server";
+
+export default getRequestConfig(async () => {
+  const locale = await getRequestLocale();
+  return { locale, messages: await loadMessages(locale), timeZone: "Asia/Bangkok" };
+});
```

   หมายเหตุ: อ่าน `cookies()` ทำให้ทุกหน้าเป็น dynamic (`/`, `/pricing`, `/legal/*` ที่เคย static จะ render ตามคำขอ) · ถ้าต้องการ static ต่อ ต้องเปลี่ยนเป็น segment `[locale]` แทน cookie ซึ่งเป็นการย้าย route ใหญ่ ไม่แนะนำรอบนี้

2. `apps/web/app/layout.tsx` (W00) ให้ `<html lang>` / provider ตามภาษา และ metadata แปลได้

```diff
-import { getMessages } from "next-intl/server";
+import { getLocale, getMessages, getTranslations } from "next-intl/server";
-import { messages } from "@/i18n/messages";
 …
-export const metadata: Metadata = {
-  title: { default: messages.common.app.name, template: `%s · ${messages.common.app.name}` },
-  description: messages.common.app.description,
-};
+export async function generateMetadata(): Promise<Metadata> {
+  const t = await getTranslations("common.app");
+  return { title: { default: t("name"), template: `%s · ${t("name")}` }, description: t("description") };
+}
 export default async function RootLayout({ children }: { children: React.ReactNode }) {
-  const allMessages = await getMessages();
+  const [locale, allMessages] = await Promise.all([getLocale(), getMessages()]);
   return (
-    <html lang="th">
+    <html lang={locale}>
       <body>
-        <NextIntlClientProvider locale="th" messages={allMessages} timeZone="Asia/Bangkok">
+        <NextIntlClientProvider locale={locale} messages={allMessages} timeZone="Asia/Bangkok">
```

3. `apps/web/src/i18n/messages.ts` + `apps/web/src/test/render.tsx` (W00) ให้ test render เป็น EN ได้

```diff
 // src/i18n/messages.ts
+import commonEn from "../../messages/en/common.json";
+import inboxBellEn from "../../messages/en/inbox-bell.json";
+import saasPagesEn from "../../messages/en/saas-pages.json";
+import searchPaletteEn from "../../messages/en/search-palette.json";
+export const messagesEn = {
+  common: commonEn, "inbox-bell": inboxBellEn, "search-palette": searchPaletteEn, "saas-pages": saasPagesEn,
+};

 // src/test/render.tsx
-  options?: RenderOptions & { messages?: Record<string, unknown> },
+  options?: RenderOptions & { messages?: Record<string, unknown>; locale?: "th" | "en" },
 …
+  const locale = options?.locale ?? "th";
       <NextIntlClientProvider
-        locale="th"
-        messages={{ ...messages, ...options?.messages }}
+        locale={locale}
+        messages={{ ...(locale === "en" ? messagesEn : messages), ...options?.messages }}
```

4. `apps/web/src/components/shell/workspace-shell.tsx` (W00) วางตัวสลับในเมนูผู้ใช้ และ sync ภาษาจากบัญชี

```diff
+import { LocaleSwitch, LocaleSync } from "@/features/locale-switch";
 …
                 <div className="menu-divider" />
+                <LocaleSwitch signedIn showYearFormat />
+                <div className="menu-divider" />
                 <Link className="workspace-item" href="/onboarding" …>
 …
+      <LocaleSync me={me.data} />
```

5. `apps/web/app/(public)/_components/site.tsx` (W19) วางตัวสลับที่หัวหน้าสาธารณะ (cookie อย่างเดียว) · หน้า `(auth)/*` ของ W01 วางแบบเดียวกันได้

```diff
+import { LocaleSwitch } from "@/features/locale-switch";
 …
         <span className={styles.spacer} />
+        <LocaleSwitch />
         <Link href="/login" className={styles.login}>
```

6. `apps/web/app/w/[ws]/profile/_components/personal-tab.tsx` (W17) เปลี่ยนภาษาในฟอร์มแล้วตั้งปีเริ่มต้นตามภาษา และหลังบันทึกให้หน้าเปลี่ยนภาษาทันที

```diff
+import { defaultYearFormat, isLocale, writeLocaleCookie } from "@/features/locale-switch";
 …
-        <Select label={t("locale")} value={form.locale} onChange={(e) => set("locale", e.target.value)}>
+        <Select label={t("locale")} value={form.locale} onChange={(e) => {
+          set("locale", e.target.value);
+          if (isLocale(e.target.value)) set("yearFormat", defaultYearFormat(e.target.value));
+        }}>
 …
         const updated = await api.request<ProfileMe>("/me", { method: "PATCH", body: changes.me });
+        if (isLocale(changes.me.locale)) { writeLocaleCookie(changes.me.locale); router.refresh(); }
```

7. `apps/web/src/lib/format.ts` และ `src/lib/api.ts` (W00) ยัง import `messages/th/common.json` และล็อก `th-TH` · ให้ `formatDate` รับ locale แล้วใช้ `dateLocale(locale, year)` (EN → "Nov 5, 2026") และข้อความ error สำรองของ `api.ts` มาจากภาษาปัจจุบัน

```diff
-const locale = (year: YearFormat) => `th-TH-u-ca-${year === "BE" ? "buddhist" : "gregory"}`;
+import { dateLocale, type AppLocale } from "@/features/locale-switch/locale";
-export function formatDate(value, year: YearFormat = "BE", fullYear = false) {
+export function formatDate(value, year: YearFormat = "BE", fullYear = false, locale: AppLocale = "th") {
 …
-  return new Intl.DateTimeFormat(locale(year), {
+  return new Intl.DateTimeFormat(dateLocale(locale, year), {
```

   (`locale.ts` import แค่ type `YearFormat` จาก format.ts จึงไม่เกิด import วนตอน runtime)

8. หน้าอื่นที่ยังเขียน `"th-TH"` ตรง ๆ ใน `Intl.*` (18 ไฟล์ เช่น `inbox-page.tsx`, `calendar-view.tsx`, `lead-dashboard.tsx`, `workload-panel.tsx`, `plan-limits/Banners.tsx`, `issue-drawer/shared.tsx`) และหน้าที่ import `messages/th/*.json` ตรงเพื่อทำ metadata (`(auth)/*/page.tsx`, `(public)/pricing`, `legal/[type]`, `IssueDrawer.tsx`) · เจ้าของแต่ละ lane เปลี่ยนเป็น `useLocale()` / `getTranslations()` เพื่อให้วันที่ ตัวเลข และ title เป็น EN ด้วย

### คำถามที่ค้าง

- ยังไม่ได้เทียบภาพกับ Canvas R3 ที่ 1440 / 390 px (ตัวสลับจะอยู่ในหน้าจริงหลังคำขอข้อ 4–5)
- M1 (โหลด / ว่าง / Error พร้อม requestId / 403) ไม่เกี่ยวกับงานนี้โดยตรง: ตัวสลับไม่มีข้อมูลให้โหลด · Error ของ PATCH แสดงข้อความจาก API ใน toast
- เทมเพลตแจ้งเตือน (Email / LINE) ที่ส่ง "ตามภาษาของผู้รับ" เป็นงานฝั่ง API (`users.locale` มีอยู่แล้ว) ยังไม่อยู่ในงานนี้

### ต่อไฟล์กลางแล้ว (หลัง merge #69)

- ข้อ 1–5 ของคำขอนอก lane ทำแล้ว: `src/i18n/request.ts` ใช้ `getRequestLocale()` + `loadMessages()` · `app/layout.tsx` ใช้ `getLocale()` ใน `<html lang>` และ provider, metadata เป็น `generateMetadata` · `messagesEn` + `renderWithProviders({ locale: "en" })` · ตัวสลับภาษา + ปีอยู่ในเมนู Workspace และ `LocaleSync` ใน shell · ตัวสลับอยู่ที่หัวเว็บสาธารณะ
- ตรวจกับ production build: cookie `NEXT_LOCALE=en` หรือ `Accept-Language: en` → `<html lang="en">` และข้อความ EN · ไม่มี → ไทย
- ยังไม่ได้ทำ: ข้อ 6 (ฟอร์มภาษาใน Profile), ข้อ 7–8 (`format.ts` / `Intl` ที่ล็อก `th-TH` และหน้าที่ import `messages/th` ตรงเพื่อทำ metadata เช่น `<title>` ของ /pricing ยังเป็นไทย) · วันที่จึงยังแสดงแบบไทยในโหมด EN
