"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { CONSENT_CHANGED, readConsent } from "@/lib/consent";

/**
 * ที่มาของผู้ใช้ (A34 · 05-business-metrics › 1.1): UTM / referrer ของการเข้าครั้งแรก
 * เขียนเป็น cookie ของโดเมนเราเอง (fm_attr อายุ 30 วัน) เฉพาะเมื่อยินยอมคุกกี้วิเคราะห์ · API อ่าน cookie นี้ตอนสมัคร (รหัสผ่าน / รับคำเชิญ / Google / Microsoft)
 * ก่อนยินยอมจำหน้าแรกไว้ใน sessionStorage ของแท็บนั้นเท่านั้น (ไม่ส่งออกไปไหน) เพื่อให้ยินยอมทีหลังแล้วยังได้ที่มาของหน้าแรก
 */
export const ATTRIBUTION_COOKIE = "fm_attr";
const PENDING_KEY = "fm_attr_pending";
const MAX_AGE = 30 * 24 * 60 * 60;
const UTM = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_term: "utmTerm" } as const;

export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  referrer?: string;
  landingPath?: string;
  firstSeenAt: string;
}

const hasCookie = () => document.cookie.split("; ").some((c) => c.startsWith(`${ATTRIBUTION_COOKIE}=`));

/** หน้าปัจจุบันเป็นที่มา · referrer นับเฉพาะเว็บอื่น (เปลี่ยนหน้าในเว็บเราไม่ใช่ที่มา) · ความยาวตามที่ API รับ */
export function landingFrom(loc: Pick<Location, "search" | "pathname" | "host">, referrer: string, now = new Date()): Attribution {
  const q = new URLSearchParams(loc.search);
  const a: Attribution = { landingPath: loc.pathname.slice(0, 300), firstSeenAt: now.toISOString() };
  for (const [param, key] of Object.entries(UTM)) {
    const v = q.get(param)?.trim();
    if (v) a[key] = v.slice(0, 100);
  }
  try {
    if (referrer && new URL(referrer).host !== loc.host) a.referrer = referrer.slice(0, 500);
  } catch {
    /* referrer เสีย: ไม่มีที่มา */
  }
  return a;
}

/** เรียกทุกครั้งที่เปลี่ยนหน้าและตอนเปลี่ยนความยินยอม · มี cookie แล้วไม่ทับ (นับการเข้าครั้งแรก) · ปฏิเสธ / ถอนความยินยอม = ลบทิ้ง */
export function captureAttribution() {
  try {
    const consent = readConsent();
    if (consent && !consent.analytics) {
      sessionStorage.removeItem(PENDING_KEY);
      if (hasCookie()) document.cookie = `${ATTRIBUTION_COOKIE}=; Max-Age=0; Path=/`;
      return;
    }
    if (hasCookie()) return;
    let pending = sessionStorage.getItem(PENDING_KEY);
    if (!pending) {
      pending = JSON.stringify(landingFrom(window.location, document.referrer));
      sessionStorage.setItem(PENDING_KEY, pending);
    }
    if (!consent) return;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${ATTRIBUTION_COOKIE}=${encodeURIComponent(pending)}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`;
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* เบราว์เซอร์ไม่ให้เก็บ: ไม่มีที่มา ไม่กระทบการใช้งาน */
  }
}

/** ใส่ใน layout ราก · ในแอปหลังล็อกอิน (/work) ไม่เก็บ เพราะคนที่ล็อกอินแล้วสมัครไปแล้ว */
export function AttributionCapture() {
  const path = usePathname();
  useEffect(() => {
    if (path?.startsWith("/work")) return;
    captureAttribution();
    window.addEventListener(CONSENT_CHANGED, captureAttribution);
    return () => window.removeEventListener(CONSENT_CHANGED, captureAttribution);
  }, [path]);
  return null;
}
