"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";
import styles from "./public.module.css";

/** ความยินยอมเก็บในเบราว์เซอร์ (03-api: ไม่มี endpoint) · เปลี่ยนเวอร์ชันเมื่อหมวดคุกกี้เปลี่ยนเพื่อถามใหม่ */
export const CONSENT_KEY = "fm_cookie_consent";
const VERSION = 1;
const OPEN_EVENT = "friday:cookie-settings";

export interface CookieConsentValue {
  v: number;
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  at: string;
}

export function readConsent(): CookieConsentValue | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    const value = raw ? (JSON.parse(raw) as CookieConsentValue) : null;
    return value?.v === VERSION ? value : null;
  } catch {
    return null;
  }
}

/** ปุ่ม "ตั้งค่าคุกกี้" ที่ footer เปิดแบนเนอร์อีกครั้งเพื่อเปลี่ยนความยินยอม */
export function openCookieSettings() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** R4 · แบนเนอร์คุกกี้ของหน้าสาธารณะ · ในแอปหลังล็อกอินใช้เฉพาะคุกกี้ที่จำเป็นจึงไม่ต้องถาม */
export function CookieConsent() {
  const t = useTranslations("saas-pages.cookie");
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const saved = readConsent();
    if (!saved) setOpen(true);
    const reopen = () => {
      const current = readConsent();
      setAnalytics(!!current?.analytics);
      setMarketing(!!current?.marketing);
      setPrefs(true);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, reopen);
    return () => window.removeEventListener(OPEN_EVENT, reopen);
  }, []);

  function save(a: boolean, m: boolean) {
    const value: CookieConsentValue = { v: VERSION, necessary: true, analytics: a, marketing: m, at: new Date().toISOString() };
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(value));
    } catch {
      /* เบราว์เซอร์ไม่ให้เก็บ: ถือว่าปฏิเสธที่ไม่จำเป็น และถามใหม่ครั้งหน้า */
    }
    setOpen(false);
    setPrefs(false);
  }

  if (!open) return null;
  return (
    <div role="region" aria-label={t("region")} className={styles.cookie}>
      <b>{t("title")}</b>
      <div className={styles.muted} style={{ fontSize: 14 }}>
        {t("description")} · <Link href="/legal/cookie">{t("policy")}</Link>
      </div>
      {prefs && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label>
            <input type="checkbox" checked disabled /> {t("necessary")}
          </label>
          <label>
            <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} /> {t("analytics")}
          </label>
          <label>
            <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} /> {t("marketing")}
          </label>
        </div>
      )}
      {/* ปุ่มยอมรับและปฏิเสธมีน้ำหนักเท่ากันตามแนวทาง PDPA จึงใช้ปุ่มแบบเดียวกันทั้งหมด */}
      <div className={styles.row} style={{ gap: 8 }}>
        <Button onClick={() => save(false, false)}>{t("reject")}</Button>
        {prefs ? <Button onClick={() => save(analytics, marketing)}>{t("save")}</Button> : <Button onClick={() => setPrefs(true)}>{t("settings")}</Button>}
        <Button onClick={() => save(true, true)}>{t("acceptAll")}</Button>
      </div>
      <div className={styles.muted} style={{ fontSize: 12 }}>
        {t("note")}
      </div>
    </div>
  );
}
