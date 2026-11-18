"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useActiveShortcuts, useShortcuts } from "@/lib/shortcuts";
import { Modal } from "./kit";

/** ป้ายปุ่มบนจอ: mod = ⌘ (Mac) / Ctrl (อื่น ๆ) */
export function keyLabel(keys: string) {
  const mac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return keys
    .split("+")
    .map((k) => (k === "mod" ? (mac ? "⌘" : "Ctrl") : k === "shift" ? "⇧" : k === "enter" ? "↵" : k === "escape" ? "Esc" : k.length === 1 ? k.toUpperCase() : k))
    .join(mac ? "" : "+");
}

export function Kbd({ keys }: { keys: string }) {
  return <kbd className="kbd">{keyLabel(keys)}</kbd>;
}

/**
 * ชุดปุ่มลัดกลางของทุกหน้า (ช่วง 2): ? เปิดรายการปุ่มลัด · / โฟกัสช่องค้นหาของหน้า (ช่องที่ใส่ data-page-search)
 * ปุ่มของแต่ละหน้าแสดงจากที่หน้านั้นลงทะเบียนไว้ตอนนี้
 */
export function ShortcutHelp() {
  const t = useTranslations("common.keys");
  const [open, setOpen] = useState(false);
  const all = useActiveShortcuts();
  useShortcuts([
    { keys: "?", run: () => setOpen((o) => !o) },
    {
      keys: "/",
      list: true,
      run: () => {
        const el = document.querySelector<HTMLInputElement>("[data-page-search]");
        el?.focus();
        el?.select();
      },
    },
  ]);
  const fixed = [
    { keys: "j", label: t("down") },
    { keys: "k", label: t("up") },
    { keys: "escape", label: t("close") },
    { keys: "/", label: t("search") },
    { keys: "mod+k", label: t("searchAll") },
    { keys: "?", label: t("help") },
  ];
  const seen = new Set(fixed.map((f) => f.keys));
  const extraGlobal = all.filter((s) => s.group === "global" && !seen.has(s.keys) && (seen.add(s.keys), true));
  const page = all.filter((s) => s.group !== "global");
  return (
    <Modal open={open} onOpenChange={setOpen} title={t("title")} description={t("desc")}>
      <div className="key-help">
        <h3>{t("global")}</h3>
        <dl>
          {[...fixed, ...extraGlobal].map((s) => (
            <div key={s.keys}>
              <dt>{s.label}</dt>
              <dd>
                <Kbd keys={s.keys} />
              </dd>
            </div>
          ))}
        </dl>
        {page.length > 0 && (
          <>
            <h3>{t("page")}</h3>
            <dl>
              {page.map((s) => (
                <div key={s.keys}>
                  <dt>{s.label}</dt>
                  <dd>
                    <Kbd keys={s.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </Modal>
  );
}
