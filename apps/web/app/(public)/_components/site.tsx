"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FridayLogo } from "@/components/brand/friday-logo";
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

/** หัวของ Landing / ราคา (R1) */
export function SiteHeader() {
  const t = useTranslations("saas-pages.site");
  return (
    <header className={styles.header}>
      <div className={cn(styles.wrap, styles.headerRow)}>
        <Brand />
        <nav aria-label={t("nav")} className={styles.nav}>
          <a href="/#features">{t("features")}</a>
          <Link href="/pricing">{t("pricing")}</Link>
          <a href="/#faq">{t("faq")}</a>
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
        <Link className={cn(buttonVariants({ variant: "primary" }), styles.btn, styles.headerCta)} href="/signup">
          {t("cta")}
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const t = useTranslations("saas-pages.site");
  return (
    <footer className={styles.footer}>
      <div className={cn(styles.wrap, styles.footerRow)}>
        <div>
          <b>Friday Work Management</b>
          {SELLER && <div>{SELLER_TAX_ID ? t("seller", { name: SELLER, taxId: SELLER_TAX_ID }) : SELLER}</div>}
        </div>
        <nav aria-label={t("legalNav")}>
          <Link href="/legal/terms">{t("terms")}</Link>
          <Link href="/legal/privacy">{t("privacy")}</Link>
          <Link href="/legal/dpa">DPA</Link>
          <Link href="/legal/cookie">Cookies</Link>
          <button type="button" className={styles.linkButton} onClick={openCookieSettings}>
            {t("cookieSettings")}
          </button>
        </nav>
      </div>
    </footer>
  );
}
