// W21 · ตัวสลับภาษา TH / EN, รูปแบบปี และการเลือกภาษาของคำขอ · ข้อมูลสมมติเท่านั้น
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { renderWithProviders } from "@/test/render";
import { router } from "@/test/router";
import { server } from "@/test/server";
import { me } from "@/test/fixtures";
import { queryKeys } from "@/lib/query";
import type { Me } from "@/lib/types";
import {
  LocaleSwitch,
  LocaleSync,
  dateLocale,
  defaultYearFormat,
  effectiveYearFormat,
  mergeMessages,
  parseAcceptLanguage,
  readLocaleCookie,
  resolveLocale,
} from "@/features/locale-switch";
import { getRequestLocale, loadMessages } from "@/features/locale-switch/server";
import enCommon from "../../messages/en/common.json";

const requestCookies = new Map<string, string>();
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name) ? { name, value: requestCookies.get(name) } : undefined,
  }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));

let patches: unknown[];
const clearCookie = () => {
  document.cookie = "NEXT_LOCALE=; Max-Age=0; Path=/";
};
const patchMe = (status = 200) =>
  http.patch("*/api/v1/me", async ({ request }) => {
    const body = (await request.json()) as Partial<Me>;
    patches.push(body);
    if (status !== 200)
      return HttpResponse.json(
        { error: { code: "internal_error", message: "ข้อผิดพลาดทดสอบ", requestId: "req_w21_001", details: {} } },
        { status },
      );
    return HttpResponse.json({ ...me, ...body });
  });

/** ห่อด้วย provider ภาษาอังกฤษ เพื่อจำลองหน้าที่ server render เป็น EN แล้ว */
const English = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ common: enCommon }} timeZone="Asia/Bangkok">
    {children}
  </NextIntlClientProvider>
);

beforeEach(() => {
  patches = [];
  clearCookie();
  requestCookies.clear();
  requestHeaders.clear();
  document.documentElement.lang = "th";
});
afterEach(clearCookie);

describe("resolveLocale / parseAcceptLanguage", () => {
  it("เลือกตามลำดับ: บัญชี → cookie → Accept-Language → ไทย", () => {
    expect(resolveLocale({ userLocale: "en", cookie: "th", acceptLanguage: "th" })).toBe("en");
    expect(resolveLocale({ cookie: "en", acceptLanguage: "th-TH" })).toBe("en");
    expect(resolveLocale({ cookie: "fr", acceptLanguage: "en-GB,en;q=0.9" })).toBe("en");
    expect(resolveLocale({ userLocale: "jp", acceptLanguage: "fr-FR,de;q=0.8" })).toBe("th");
    expect(resolveLocale()).toBe("th");
  });

  it("อ่านค่า q ของ Accept-Language และข้ามภาษาที่ไม่รองรับ", () => {
    expect(parseAcceptLanguage("en;q=0.5, th;q=0.9")).toBe("th");
    expect(parseAcceptLanguage("fr-FR, en-US;q=0.7, th;q=0.3")).toBe("en");
    expect(parseAcceptLanguage("EN-us")).toBe("en");
    expect(parseAcceptLanguage("th;q=0, en;q=0.1")).toBe("en");
    expect(parseAcceptLanguage("de, fr")).toBeNull();
    expect(parseAcceptLanguage("")).toBeNull();
    expect(parseAcceptLanguage(null)).toBeNull();
  });

  it("ปีเริ่มต้น: ไทย = พ.ศ. · English = ค.ศ. และใช้ค่าที่ผู้ใช้ตั้งเองก่อน", () => {
    expect(defaultYearFormat("th")).toBe("BE");
    expect(defaultYearFormat("en")).toBe("CE");
    expect(effectiveYearFormat("en")).toBe("CE");
    expect(effectiveYearFormat("en", "BE")).toBe("BE");
    const date = new Date("2026-11-05T05:00:00Z");
    const format = (tag: string) =>
      new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }).format(date);
    expect(format(dateLocale("en", "CE"))).toBe("Nov 5, 2026");
    expect(format(dateLocale("th", "BE"))).toContain("2569");
  });
});

describe("ฝั่ง server: getRequestLocale / loadMessages", () => {
  it("อ่าน cookie NEXT_LOCALE ก่อน Accept-Language", async () => {
    requestHeaders.set("accept-language", "en-US,en;q=0.9");
    expect(await getRequestLocale()).toBe("en");
    requestCookies.set("NEXT_LOCALE", "th");
    expect(await getRequestLocale()).toBe("th");
  });

  it("โหลดข้อความ EN ทับไทย · key ที่ยังไม่แปลแสดงเป็นไทยแทนรหัสข้อความ", async () => {
    const real = await loadMessages("en");
    expect((real.common as typeof enCommon).app.close).toBe("Close");
    expect(Object.keys(real)).toEqual(expect.arrayContaining(["common", "profile", "saas-pages"]));

    const root = mkdtempSync(join(tmpdir(), "w21-"));
    mkdirSync(join(root, "th"));
    mkdirSync(join(root, "en"));
    writeFileSync(join(root, "th", "demo.json"), JSON.stringify({ a: { b: "ไทย บี", c: "ไทย ซี" }, list: ["หนึ่ง", "สอง"] }));
    writeFileSync(join(root, "en", "demo.json"), JSON.stringify({ a: { b: "English B" }, list: ["One"] }));
    expect(await loadMessages("en", root)).toEqual({ demo: { a: { b: "English B", c: "ไทย ซี" }, list: ["One"] } });
    expect(await loadMessages("th", root)).toEqual({ demo: { a: { b: "ไทย บี", c: "ไทย ซี" }, list: ["หนึ่ง", "สอง"] } });
  });

  it("mergeMessages ไม่แก้ object ต้นฉบับ", () => {
    const base = { a: { b: "1" } };
    expect(mergeMessages(base, { a: { c: "2" } })).toEqual({ a: { b: "1", c: "2" } });
    expect(base).toEqual({ a: { b: "1" } });
  });
});

describe("LocaleSwitch", () => {
  it("หน้าสาธารณะ: เปลี่ยนเป็น English ด้วย cookie อย่างเดียว ไม่เรียก PATCH /me", async () => {
    const onChange = vi.fn();
    renderWithProviders(<LocaleSwitch onChange={onChange} />);
    const group = screen.getByRole("group", { name: "ภาษาของระบบ" });
    expect(screen.getByRole("button", { name: "ไทย" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "รูปแบบปี" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(readLocaleCookie()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(onChange).toHaveBeenCalledWith({ locale: "en", yearFormat: "CE" });
    expect(patches).toEqual([]);
    expect(group).toBeInTheDocument();
  });

  it("ล็อกอินแล้ว: เลือก English บันทึก locale + ปี ค.ศ. ผ่าน PATCH /me แล้วอัปเดต cache", async () => {
    server.use(patchMe());
    const { client } = renderWithProviders(<LocaleSwitch signedIn showYearFormat />);
    expect(await screen.findByRole("button", { name: "พ.ศ." })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([{ locale: "en", yearFormat: "CE" }]);
    expect(readLocaleCookie()).toBe("en");
    expect(client.getQueryData<Me>(queryKeys.me)).toMatchObject({ locale: "en", yearFormat: "CE" });
  });

  it("ล็อกอินแล้วใน EN: เปลี่ยนเฉพาะรูปแบบปีโดยไม่ refresh และกลับเป็นไทยได้", async () => {
    server.use(
      http.get("*/api/v1/me", () => HttpResponse.json({ ...me, locale: "en", yearFormat: "CE" })),
      patchMe(),
    );
    renderWithProviders(
      <English>
        <LocaleSwitch signedIn showYearFormat />
      </English>,
    );
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "A.D." })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "B.E." }));
    await waitFor(() => expect(patches).toEqual([{ yearFormat: "BE" }]));
    expect(await screen.findByRole("button", { name: "B.E." })).toHaveAttribute("aria-pressed", "true");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(readLocaleCookie()).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "ไทย" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    // ปีที่ตั้งไว้เป็น พ.ศ. อยู่แล้ว จึงส่งแค่ภาษา
    expect(patches).toEqual([{ yearFormat: "BE" }, { locale: "th" }]);
    expect(readLocaleCookie()).toBe("th");
  });

  it("PATCH /me ไม่สำเร็จ: แจ้งข้อความ error และไม่เปลี่ยน cookie / ไม่ refresh", async () => {
    server.use(patchMe(500));
    renderWithProviders(<LocaleSwitch signedIn />);
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByText("ข้อผิดพลาดทดสอบ")).toBeInTheDocument();
    expect(patches).toEqual([{ locale: "en", yearFormat: "CE" }]);
    expect(readLocaleCookie()).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "ไทย" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("LocaleSync", () => {
  it("ภาษาในบัญชีต่างจากหน้าปัจจุบัน: เขียน cookie แล้ว refresh", async () => {
    renderWithProviders(<LocaleSync me={{ locale: "en" }} />);
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(readLocaleCookie()).toBe("en");
  });

  it("ภาษาตรงกันแล้ว: เติม cookie ให้ครบโดยไม่ refresh · ไม่มีข้อมูล /me ไม่ทำอะไร", async () => {
    const { rerender } = renderWithProviders(<LocaleSync me={undefined} />);
    expect(readLocaleCookie()).toBeNull();
    rerender(<LocaleSync me={{ locale: "th" }} />);
    await waitFor(() => expect(readLocaleCookie()).toBe("th"));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
