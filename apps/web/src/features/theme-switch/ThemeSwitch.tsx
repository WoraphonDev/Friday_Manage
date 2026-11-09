"use client";

// ตัวเลือกธีม สว่าง / มืด / ตามระบบ · วางคู่กับตัวสลับภาษา (เมนูบัญชี, เมนูมือถือ, หน้าสาธารณะ)
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  DEFAULT_THEME,
  THEME_EVENT,
  THEME_PREFS,
  applyThemePref,
  readThemePref,
  type ThemePref,
} from "./theme";
import styles from "./theme-switch.module.css";

// ข้อความอยู่ใน namespace locale-switch (โหลดทุกหน้า รวมหน้าสาธารณะ) ร่วมกับตัวสลับภาษา

const ICONS = { light: Sun, dark: Moon, system: Monitor } satisfies Record<ThemePref, unknown>;

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

export function ThemeSwitch({
  showLabels = false,
  onChange,
  className,
  "aria-labelledby": labelledBy,
}: {
  /** true = แสดงชื่อข้างไอคอน (พื้นที่กว้าง เช่น เมนูมือถือ) */
  showLabels?: boolean;
  onChange?: (pref: ThemePref) => void;
  className?: string;
  /** ใช้หัวข้อของฟอร์มเป็นชื่อกลุ่มแทนคำว่า "ธีม" */
  "aria-labelledby"?: string;
}) {
  const t = useTranslations("locale-switch.theme");
  // server ไม่รู้ค่าในหน้าที่เปิดอยู่ จึงเริ่มจากค่าเริ่มต้นแล้วอ่านจาก <html> หลัง hydrate
  const pref = useSyncExternalStore(subscribe, readThemePref, () => DEFAULT_THEME);

  return (
    <div className={[styles.seg, className].filter(Boolean).join(" ")} role="group" aria-label={labelledBy ? undefined : t("label")} aria-labelledby={labelledBy}>
      {THEME_PREFS.map((option) => {
        const Icon = ICONS[option];
        return (
          <button
            key={option}
            type="button"
            aria-pressed={option === pref}
            aria-label={showLabels ? undefined : t(option)}
            title={t(option)}
            onClick={() => {
              if (option === pref) return;
              applyThemePref(option);
              onChange?.(option);
            }}
          >
            <Icon size={15} aria-hidden="true" />
            {showLabels && <span>{t(option)}</span>}
          </button>
        );
      })}
    </div>
  );
}
