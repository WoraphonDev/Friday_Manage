"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PageEnter } from "@/components/shell/page-enter";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "./public.module.css";
import { SiteFooter, SiteHeader } from "./site";

const NEEDS = ["sso", "annual_contract", "tax_invoice", "onboarding", "api", "security_review", "other"] as const;

/** ฟอร์มติดต่อฝ่ายขาย (O54) · ส่งแล้วเป็น Lead ใน Friday Ops · ต้องยินยอมให้ติดต่อกลับ (PDPA) · ช่อง website ซ่อนไว้ดักบอท */
export function ContactSalesPage() {
  const t = useTranslations("saas-pages.contactSales");
  const [f, setF] = useState({ company: "", contactName: "", contactTitle: "", email: "", phone: "", teamSize: "", message: "", website: "" });
  const [needs, setNeeds] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api.post("/public/contact-sales", {
        company: f.company.trim(), contactName: f.contactName.trim(), email: f.email.trim(), teamSize: Number(f.teamSize), needs, consent: true,
        ...(f.contactTitle.trim() ? { contactTitle: f.contactTitle.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.message.trim() ? { message: f.message.trim() } : {}),
        ...(f.website ? { website: f.website } : {}),
      }),
  });
  const ok = f.company.trim().length >= 2 && f.contactName.trim().length >= 2 && /.+@.+\..+/.test(f.email) && Number(f.teamSize) > 0 && consent;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className={styles.page}>
      <SiteHeader />
      <PageEnter>
        <main className={`${styles.wrap} ${styles.section}`}>
          <div className={styles.contactGrid}>
            <div className={styles.stackLg}>
              <h1>{t("title")}</h1>
              <p className={styles.lead}>{t("lead")}</p>
            </div>
            {send.isSuccess ? (
              <section className={styles.contactCard} aria-live="polite">
                <h2>{t("done")}</h2>
                <p className={styles.muted}>{t("doneLead")}</p>
                <div className={styles.row}>
                  <Link className="button button-primary" href="/signup">
                    {t("trial")}
                  </Link>
                  <Link className="button" href="/pricing">
                    {t("back")}
                  </Link>
                </div>
              </section>
            ) : (
              <form className={styles.contactCard} onSubmit={(e) => (e.preventDefault(), ok && !send.isPending && send.mutate())}>
                <Input label={t("company")} value={f.company} onChange={set("company")} required autoComplete="organization" />
                <div className={styles.contactPair}>
                  <Input label={t("name")} value={f.contactName} onChange={set("contactName")} required autoComplete="name" />
                  <Input label={t("jobTitle")} value={f.contactTitle} onChange={set("contactTitle")} autoComplete="organization-title" />
                </div>
                <div className={styles.contactPair}>
                  <Input label={t("email")} type="email" value={f.email} onChange={set("email")} required autoComplete="email" />
                  <Input label={t("phone")} type="tel" value={f.phone} onChange={set("phone")} autoComplete="tel" />
                </div>
                <Input label={t("teamSize")} type="number" min={1} value={f.teamSize} onChange={set("teamSize")} required />
                <fieldset className={styles.contactNeeds}>
                  <legend>{t("needs")}</legend>
                  {NEEDS.map((n) => (
                    <label key={n}>
                      <input type="checkbox" checked={needs.includes(n)} onChange={() => setNeeds(needs.includes(n) ? needs.filter((x) => x !== n) : [...needs, n])} /> {t(`needOpts.${n}`)}
                    </label>
                  ))}
                </fieldset>
                <div className="field">
                  <label htmlFor="cs-message">{t("message")}</label>
                  <textarea id="cs-message" className="input" rows={4} value={f.message} onChange={set("message")} />
                </div>
                {/* ช่องดักบอท: คนไม่เห็น โปรแกรมกรอกอัตโนมัติมักเติม */}
                <input className={styles.honeypot} tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={f.website} onChange={set("website")} />
                <label className={styles.consent}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>
                    {t("consent")} ·{" "}
                    <Link href="/legal/privacy" target="_blank">
                      {t("privacy")}
                    </Link>
                  </span>
                </label>
                {send.error && (
                  <p className="field-error" role="alert">
                    {(send.error as Error).message}
                  </p>
                )}
                <Button type="submit" variant="primary" disabled={!ok || send.isPending}>
                  {send.isPending ? t("sending") : t("submit")}
                </Button>
              </form>
            )}
          </div>
        </main>
      </PageEnter>
      <SiteFooter />
    </div>
  );
}
