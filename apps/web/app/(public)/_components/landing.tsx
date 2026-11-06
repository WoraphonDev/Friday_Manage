"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PricingSection } from "./pricing";
import { SiteFooter, SiteHeader } from "./site";
import styles from "./public.module.css";

interface KanbanColumn {
  name: string;
  cards: { title: string; meta: string; color: string }[];
}

/** R1 · Landing (ฟีเจอร์ + ราคา + คำถามที่พบบ่อย) */
export function Landing() {
  const t = useTranslations("saas-pages.landing");
  const kanban = t.raw("kanban") as KanbanColumn[];
  const features = t.raw("features") as { name: string; description: string }[];
  const faq = t.raw("faq") as { q: string; a: string }[];
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main>
        <section className={styles.hero}>
          <div className={cn(styles.wrap, styles.heroRow)}>
            <div className={styles.heroText}>
              <span className={styles.badge}>{t("badge")}</span>
              <h1>{t("title")}</h1>
              <p className={cn(styles.muted, styles.lead)}>{t("lead")}</p>
              <div className={styles.row}>
                <Link className={cn(buttonVariants({ variant: "primary" }), styles.btn)} href="/signup">
                  {t("cta")}
                </Link>
                <Link className={cn(buttonVariants(), styles.btn)} href="/pricing">
                  {t("seePrice")}
                </Link>
              </div>
              <div className={cn(styles.muted, styles.small)}>{t("note")}</div>
            </div>
            <div className={styles.preview} role="img" aria-label={t("previewLabel")}>
              <div className={styles.previewBar}>
                <span />
                <span />
                <span />
              </div>
              <div className={styles.kanban} aria-hidden="true">
                {kanban.map((c) => (
                  <div key={c.name} className={styles.kcol}>
                    <b>{c.name}</b>
                    {c.cards.map((k) => (
                      <div key={k.title} className={styles.kcard}>
                        <i style={{ background: k.color }} />
                        {k.title}
                        <small>{k.meta}</small>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="features" className={styles.section} aria-labelledby="features-title">
          <div className={cn(styles.wrap, styles.stackLg)}>
            <h2 id="features-title">{t("featuresTitle")}</h2>
            <div className={styles.features}>
              {features.map((f) => (
                <div key={f.name} className={styles.feat}>
                  <b>{f.name}</b>
                  <span className={styles.muted}>{f.description}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <PricingSection />

        <section id="faq" className={styles.section} aria-labelledby="faq-title">
          <div className={cn(styles.wrap, styles.faqWrap)}>
            <h2 id="faq-title">{t("faqTitle")}</h2>
            {faq.map((q) => (
              <details key={q.q} className={styles.faq}>
                <summary>
                  {q.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p className={styles.muted}>{q.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

/** /pricing · ราคาอย่างเดียว พร้อมหัวและท้ายเว็บ */
export function PricingPage() {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main>
        <PricingSection heading="h1" />
      </main>
      <SiteFooter />
    </div>
  );
}
