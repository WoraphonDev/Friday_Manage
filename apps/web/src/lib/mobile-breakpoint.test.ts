// W27 · เส้นแบ่งมือถือมีค่าเดียว (760px) ทั้ง CSS และ useIsMobile
// เดิม issue-drawer / kanban ใช้ 767px ทำให้จอ 761–767px ได้ drawer/บอร์ดแบบมือถือแต่ส่วนอื่นเป็น desktop
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_QUERY } from "./use-mobile";

const webRoot = join(__dirname, "../..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("เส้นแบ่งมือถือ", () => {
  it("useIsMobile ใช้ 760px", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 760px)");
  });

  it("ทุก @media max-width ในช่วงมือถือ/แท็บเล็ต (700–800px) เป็น 760px", () => {
    const offenders = ["src", "app"].flatMap((dir) =>
      cssFiles(join(webRoot, dir)).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/@media[^{]*max-width:\s*(\d+)px/g)]
          .map((match) => Number(match[1]))
          .filter((px) => px >= 700 && px <= 800 && px !== 760)
          .map((px) => `${file.slice(webRoot.length + 1)}: ${px}px`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
