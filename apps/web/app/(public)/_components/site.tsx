"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FridayLogo, FridayMark } from "@/components/brand/friday-logo";
import { buttonVariants } from "@/components/ui";
import { LocaleSwitch } from "@/features/locale-switch";
import { ThemeSwitch } from "@/features/theme-switch";
import { cn } from "@/lib/utils";
import { openCookieSettings } from "./cookie-consent";
import styles from "./public.module.css";

// ข้อมูลผู้ขายจริงตั้งตอน deploy (repo เป็น Public จึงไม่ใส่ในโค้ด) · ไม่ตั้ง = ไม่แสดงบรรทัดนี้
const SELLER = process.env.NEXT_PUBLIC_SELLER_NAME;
const SELLER_TAX_ID = process.env.NEXT_PUBLIC_SELLER_TAX_ID;

export function Brand() {
  return (
    <Link href="/" className={styles.brand}>
      <FridayLogo />
    </Link>
  );
}

const SECTIONS = ["features", "pricing", "faq"] as const;

/** หัวเว็บเป็นกระจกฝ้าเมื่อเลื่อนพ้นด้านบน และขีดเส้นใต้เมนูของส่วนที่กำลังอ่าน (เฉพาะส่วนที่มีในหน้านั้น) */
function useHeaderScroll() {
  const [stuck, setStuck] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setStuck(window.scrollY > 8);
      const mid = window.innerHeight * 0.35;
      setSection(
        SECTIONS.find((id) => {
          const r = document.getElementById(id)?.getBoundingClientRect();
          return !!r && r.top < mid && r.bottom > mid;
        }) ?? null,
      );
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return { stuck, section };
}

/** หัวของ Landing / ราคา (R1) */
export function SiteHeader() {
  const t = useTranslations("saas-pages.site");
  const { stuck, section } = useHeaderScroll();
  return (
    <header className={styles.header} data-stuck={stuck || undefined}>
      <div className={cn(styles.wrap, styles.headerRow)}>
        <Brand />
        <nav aria-label={t("nav")} className={styles.nav}>
          <a href="/#features" data-active={section === "features" || undefined}>
            {t("features")}
          </a>
          <Link href="/pricing" data-active={section === "pricing" || undefined}>
            {t("pricing")}
          </Link>
          <a href="/#faq" data-active={section === "faq" || undefined}>
            {t("faq")}
          </a>
          {/* W26 · ศูนย์ช่วยเหลือสาธารณะ (SEO) */}
          <Link href="/help">{t("help")}</Link>
        </nav>
        <span className={styles.spacer} />
        {/* รวมภาษา + ธีมเป็นกลุ่มเดียว แต่งเป็นแถบโปร่งให้เบากว่าปุ่มหลักของหัวหน้า */}
        <div className={styles.prefs}>
          <LocaleSwitch />
          <ThemeSwitch />
        </div>
        <Link href="/login" className={styles.login}>
          {t("login")}
        </Link>
        <Link className={cn(buttonVariants({ variant: "primary" }), styles.btn, styles.headerCta, styles.shine)} href="/signup">
          {t("cta")}
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const t = useTranslations("saas-pages.site");
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={styles.wrap}>
        {/* แถบชวนทดลองใช้ก่อนออกจากหน้า · ไทล์ logo ขยับเหมือนตัวโลโก้ */}
        <section className={styles.footerCta} aria-labelledby="footer-cta-title">
          <div className={styles.footerCtaText}>
            <h2 id="footer-cta-title">{t("ctaTitle")}</h2>
            <p>{t("ctaLead")}</p>
          </div>
          <Link className={cn(buttonVariants({ variant: "primary" }), styles.btn, styles.shine)} href="/signup">
            {t("cta")}
          </Link>
          <FridayMark className={styles.footerMark} />
        </section>

        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.brand}>
              <FridayLogo tone="dark" />
            </Link>
            <p>{t("footerTagline")}</p>
          </div>
          <nav aria-label={t("productNav")} className={styles.footerCol}>
            <b>{t("productNav")}</b>
            <a href="/#features">{t("features")}</a>
            <Link href="/pricing">{t("pricing")}</Link>
            <a href="/#faq">{t("faq")}</a>
          </nav>
          <nav aria-label={t("helpNav")} className={styles.footerCol}>
            <b>{t("helpNav")}</b>
            <Link href="/help">{t("help")}</Link>
            <Link href="/signup">{t("signup")}</Link>
          </nav>
          <nav aria-label={t("legalNav")} className={styles.footerCol}>
            <b>{t("legalNav")}</b>
            <Link href="/legal/terms">{t("terms")}</Link>
            <Link href="/legal/privacy">{t("privacy")}</Link>
            <Link href="/legal/dpa">DPA</Link>
            <Link href="/legal/cookie">Cookies</Link>
            <button type="button" className={styles.linkButton} onClick={openCookieSettings}>
              {t("cookieSettings")}
            </button>
          </nav>
        </div>

        <div className={styles.footerBottom}>
          <div>
            <span>{t("copyright", { year })}</span>
            {SELLER && <span>{SELLER_TAX_ID ? t("seller", { name: SELLER, taxId: SELLER_TAX_ID }) : SELLER}</span>}
          </div>
          <span>{t("trust")}</span>
        </div>
      </div>
    </footer>
  );
}
