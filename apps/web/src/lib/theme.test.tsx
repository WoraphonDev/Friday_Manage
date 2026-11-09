// ธีมสว่าง / มืด / ตามระบบ · ชุดสีตาม logo (แบบ C)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import {
  THEME_SCRIPT,
  ThemeSwitch,
  applyThemePref,
  isThemePref,
  readThemePref,
  resolveTheme,
} from "@/features/theme-switch";

const root = document.documentElement;

function mockSystemDark(dark: boolean) {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];
  const query = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.push(fn),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    change(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

beforeEach(() => {
  root.removeAttribute("data-theme");
  root.removeAttribute("data-theme-pref");
  document.cookie = "fm-theme=; Path=/; Max-Age=0";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ค่าธีม", () => {
  it("รับเฉพาะ light / dark / system และ system ตามโหมดของเครื่อง", () => {
    expect(["light", "dark", "system", "auto", undefined].map(isThemePref)).toEqual([true, true, true, false, false]);
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("สคริปต์ใน <head> ตั้ง data-theme ก่อนวาดหน้า และตามระบบเมื่อเลือก ตามระบบ", () => {
    const system = mockSystemDark(true);
    root.setAttribute("data-theme-pref", "system");
    new Function(THEME_SCRIPT)();
    expect(root.getAttribute("data-theme")).toBe("dark");
    system.change(false);
    expect(root.getAttribute("data-theme")).toBe("light");

    // เลือกโหมดเองแล้ว ระบบเปลี่ยนก็ไม่กระทบ
    root.setAttribute("data-theme-pref", "dark");
    system.change(false);
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("ไม่มีค่าที่ server ส่งมา = สว่าง", () => {
    mockSystemDark(true);
    new Function(THEME_SCRIPT)();
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(readThemePref()).toBe("light");
  });

  it("เปลี่ยนธีมทันทีและจำไว้ใน cookie", () => {
    mockSystemDark(false);
    applyThemePref("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-theme-pref")).toBe("dark");
    expect(document.cookie).toContain("fm-theme=dark");
    applyThemePref("system");
    expect(root.getAttribute("data-theme")).toBe("light");
    expect(document.cookie).toContain("fm-theme=system");
  });
});

describe("ThemeSwitch", () => {
  it("แสดง 3 ตัวเลือก กดแล้วเปลี่ยนธีมและสถานะปุ่ม", async () => {
    mockSystemDark(true);
    root.setAttribute("data-theme-pref", "light");
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ThemeSwitch onChange={onChange} />);
    const group = screen.getByRole("group", { name: "ธีม" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "สว่าง" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "มืด" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "มืด" })).toHaveAttribute("aria-pressed", "true");
    expect(onChange).toHaveBeenLastCalledWith("dark");

    await user.click(screen.getByRole("button", { name: "ตามระบบ" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "ตามระบบ" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ใช้หัวข้อของฟอร์มเป็นชื่อกลุ่ม (หน้า Profile)", () => {
    renderWithProviders(<><span id="theme-label">ธีมการแสดงผล</span><ThemeSwitch showLabels aria-labelledby="theme-label" /></>);
    expect(screen.getByRole("group", { name: "ธีมการแสดงผล" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ตามระบบ" })).toHaveTextContent("ตามระบบ");
  });

  it("ภาษาอังกฤษ + แสดงชื่อข้างไอคอน", () => {
    renderWithProviders(<ThemeSwitch showLabels />, { locale: "en" });
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark" })).toHaveTextContent("Dark");
  });
});

// กันสีเขียนตรงกลับเข้ามา: โหมดมืดจะมีจุดสีค้างทันที ให้เพิ่ม token ใน tokens.css แทน
describe("ชุดสีอยู่ใน tokens.css ที่เดียว", () => {
  const webRoot = join(__dirname, "../..");
  const ALLOWED = new Set([
    "src/styles/tokens.css",
    // สีแบรนด์ของ logo คงที่ทุกโหมด
    "src/components/brand/friday-logo.module.css",
  ]);
  function cssFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === ".next") return [];
      if (statSync(path).isDirectory()) return cssFiles(path);
      return name.endsWith(".css") ? [path] : [];
    });
  }

  it("ไฟล์ CSS อื่นไม่มีสี hex หรือ white", () => {
    const offenders = [...cssFiles(join(webRoot, "app")), ...cssFiles(join(webRoot, "src"))]
      .map((path) => path.slice(webRoot.length + 1))
      .filter((path) => !ALLOWED.has(path))
      .flatMap((path) => {
        const css = readFileSync(join(webRoot, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        // ตัวดูไฟล์แสดงเอกสารบนกระดาษขาวเสมอ (เหมือนเปิดไฟล์จริง) จึงยกเว้นเฉพาะ block นั้น
        const checked = css.replace(/\.file-preview-(img|frame|text)\b[^{]*\{[^}]*\}/g, "");
        const hits = checked.match(/#[0-9a-f]{3,8}\b|:\s*white\b/gi) ?? [];
        return hits.map((hit) => `${path}: ${hit}`);
      });
    expect(offenders).toEqual([]);
  });

  it("ทุก token ของโหมดสว่างมีค่าโหมดมืดเมื่อเป็นสี", () => {
    const tokens = readFileSync(join(webRoot, "src/styles/tokens.css"), "utf8");
    const [light, dark] = tokens.split(':root[data-theme="dark"]');
    const names = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].filter(([, , value]) => /#|rgb/.test(value)).map(([, name]) => name));
    const lightColors = names(light);
    const darkColors = names(dark);
    // ค่าที่ตั้งใจให้เหมือนกันทั้งสองโหมด (ไม่ต้องประกาศซ้ำในโหมดมืด)
    const SAME = ["--inverse-ink", "--inverse-muted", "--inverse-link", "--inverse-link-hover", "--inverse-success",
      "--status-progress-bg", "--status-progress-fg", "--status-review-bg", "--status-review-fg",
      "--status-done-bg", "--status-done-fg", "--status-overdue-bg", "--status-overdue-fg"];
    const missing = [...lightColors].filter((name) => !darkColors.has(name) && !SAME.includes(name));
    expect(missing).toEqual([]);
  });
});
