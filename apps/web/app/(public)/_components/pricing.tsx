"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, LoadingState, buttonVariants } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { baht, fitPlan, type PlanCode, type PublicPlan, type PublicPlans } from "@/features/plan-limits";
import styles from "./public.module.css";

export type Cyc = "monthly" | "yearly";
/** ปุ่มของแต่ละแพ็กเกจ · ไม่มี href = แสดงเป็นป้ายเฉย ๆ (เช่น แพ็กเกจปัจจุบัน) */
export type PlanCta = { label: string; href?: string };
// ช่องทางติดต่อฝ่ายขายตั้งตอน deploy · ไม่ตั้ง = ไปหน้าสมัครพร้อมแพ็กเกจ Enterprise ให้ทีมติดต่อกลับ
const SALES_URL = process.env.NEXT_PUBLIC_SALES_URL ?? "/signup?plan=enterprise";

/**
 * R1 · ราคาเหมาตามขนาดทีม (ใช้ทั้งใน Landing, /pricing และ /work/:ws/billing/plans) · ราคาและขีดจำกัดจาก `GET public/plans`
 * ในระบบส่ง `ctaFor` ให้ปุ่มไปหน้าชำระเงินของ Workspace แทนหน้าสมัคร (ไม่หลุดออกจากระบบ)
 */
export function PricingSection({ heading = "h2", ctaFor }: { heading?: "h1" | "h2"; ctaFor?: (p: PublicPlan, cycle: Cyc) => PlanCta }) {
  const t = useTranslations("saas-pages.pricing");
  const [cycle, setCycle] = useState<Cyc>("monthly");
  const [team, setTeam] = useState(12);
  const plans = useQuery({ queryKey: ["public-plans"], queryFn: () => api.get<PublicPlans>("/public/plans"), staleTime: 300_000 });
  const H = heading;
  // แถบเลื่อนใต้ปุ่มรอบชำระ: วัดจากปุ่มจริงเพราะความยาวคำต่างกันตามภาษา
  const seg = useRef<HTMLDivElement>(null);
  const segInd = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const btn = seg.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!btn || !segInd.current) return;
      segInd.current.style.width = `${btn.offsetWidth}px`;
      segInd.current.style.transform = `translateX(${btn.offsetLeft}px)`;
    };
    place();
    window.addEventListener("resize", place);
    document.fonts?.ready.then(place).catch(() => {});
    return () => window.removeEventListener("resize", place);
  }, [cycle, plans.data]);

  return (
    <section id="pricing" className={cn(styles.pricing, ctaFor && styles.embedded)} aria-labelledby="pricing-title">
      <div className={cn(styles.wrap, styles.stackLg)}>
        <div className={styles.pricingHead}>
          <H id="pricing-title" style={{ fontSize: 28 }}>
            {t("title")}
          </H>
          <div className={styles.muted}>{t("subtitle")}</div>
          <div ref={seg} className={styles.seg} role="group" aria-label={t("cycle")}>
            <span ref={segInd} className={styles.segInd} aria-hidden="true" />
            <button type="button" aria-pressed={cycle === "monthly"} onClick={() => setCycle("monthly")}>
              {t("monthly")}
            </button>
            <button type="button" aria-pressed={cycle === "yearly"} onClick={() => setCycle("yearly")}>
              {t("yearly")} <span className={styles.save}>{t("save", { months: 12 - (plans.data?.yearlyMonths ?? 10) })}</span>
            </button>
          </div>
        </div>
        {plans.isPending ? (
          <LoadingState />
        ) : plans.error ? (
          <ErrorState error={plans.error} retry={() => plans.refetch()} />
        ) : (
          <Plans data={plans.data} cycle={cycle} team={team} setTeam={setTeam} ctaFor={ctaFor} />
        )}
      </div>
    </section>
  );
}

function Plans({ data, cycle, team, setTeam, ctaFor }: { data: PublicPlans; cycle: Cyc; team: number; setTeam: (n: number) => void; ctaFor?: (p: PublicPlan, cycle: Cyc) => PlanCta }) {
  const t = useTranslations("saas-pages.pricing");
  // แพ็กเกจที่ทีม Friday ซ่อนจากหน้าราคา (O20) ไม่แสดง
  const items = data.items.filter((p) => p.listed !== false);
  const fit = fitPlan(items, team);
  const paid = (p: PublicPlan) => !p.contactSales && p.code !== "free";
  const prevLimit = (i: number) => items[i - 1]?.seatLimit ?? 0;

  const bullets = (p: PublicPlan): string[] => {
    if (p.code === "free")
      return [
        t("bullets.projects", { n: p.projectLimit ?? 0 }),
        t("bullets.freeViews"),
        t("bullets.freeNotify"),
        t("bullets.freeFiles", { gb: p.storageGbPerMember ?? 0 }),
      ];
    if (p.contactSales) return t.raw("bullets.enterprise") as string[];
    return [t("bullets.unlimited"), t("bullets.paidViews"), t("bullets.paidImport"), t("bullets.paidLine"), t("bullets.paidFiles", { gb: p.storageGbPerMember ?? 0 })];
  };
  const price = (p: PublicPlan) => {
    if (p.contactSales) return { price: t("custom"), unit: "", sub: "" };
    const yearly = cycle === "yearly" && paid(p);
    const satang = (yearly ? p.priceYearlySatang : p.priceMonthlySatang) ?? 0;
    return { price: `฿${baht(satang)}`, unit: yearly ? t("perYear") : t("perMonth"), sub: yearly ? t("billedYearly") : "" };
  };
  const cta = (p: PublicPlan): PlanCta =>
    ctaFor ? ctaFor(p, cycle) : p.code === "free"
      ? { label: t("start"), href: "/signup" }
      : p.contactSales
        ? { label: t("contact"), href: SALES_URL }
        : { label: t("trial", { days: data.trialDays }), href: `/signup?plan=${p.code}&cycle=${cycle}` };

  const yes = "✓";
  const no = "–";
  const has = (p: PublicPlan, f: string) => (p.features.includes(f) ? yes : no);
  const byCode = (key: string) => (p: PublicPlan) => t(`compare.${key}.${p.code as PlanCode}`);
  const rows: [string, (p: PublicPlan, i: number) => string][] = [
    [t("compare.members"), (p, i) => (p.seatLimit === null ? `${prevLimit(i)}+` : String(p.seatLimit))],
    [t("compare.projects"), (p) => (p.projectLimit === null ? t("compare.unlimited") : String(p.projectLimit))],
    ["Gantt, Workload, Sprint", (p) => has(p, "gantt")],
    [t("compare.excel"), (p) => has(p, "import_excel")],
    ["Automation", byCode("automation")],
    [t("compare.line"), (p) => has(p, "line_oa")],
    ["SSO / SAML", (p) => (p.contactSales ? yes : no)],
    ["Audit log", byCode("audit")],
  ];

  return (
    <>
      <div className={styles.team}>
        <label htmlFor="team-size">{t("teamQ")}</label>
        <input id="team-size" type="range" min={1} max={60} value={team} onChange={(e) => setTeam(Number(e.target.value))} />
        <b>{t("people", { n: team })}</b>
        {fit && <span className={styles.pill}>{t("fit", { plan: fit.name })}</span>}
      </div>
      <div className={styles.plans}>
        {items.map((p, i) => {
          const hot = fit?.code === p.code;
          const pr = price(p);
          const c = cta(p);
          return (
            <article key={p.code} className={cn(styles.plan, hot && styles.hot)} aria-label={p.name}>
              {hot && <span className={cn(styles.pill, styles.fitTag)}>{t("fitTag")}</span>}
              <b>{p.name}</b>
              <span className={cn(styles.muted, styles.small)}>{p.seatLimit === null ? t("sizeOver", { n: prevLimit(i) }) : t("sizeUpTo", { n: p.seatLimit })}</span>
              <div>
                <span key={pr.price} className={styles.price}>
                  {pr.price}
                </span> <span className={cn(styles.muted, styles.small)}>{pr.unit}</span>
              </div>
              <span className={cn(styles.muted, styles.sub)}>{pr.sub}</span>
              {c.href ? (
                <Link className={cn(buttonVariants({ variant: hot ? "primary" : "secondary" }), styles.btn)} href={c.href}>
                  {c.label}
                </Link>
              ) : (
                <span className={cn(buttonVariants({ variant: "secondary" }), styles.btn)} aria-disabled="true">
                  {c.label}
                </span>
              )}
              <ul>
                {bullets(p).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
      <div className={cn(styles.muted, styles.small, styles.center)}>{t("vat")}</div>
      <details className={styles.cmpBox}>
        <summary>{t("compare.title")}</summary>
        <div className={styles.cmpScroll}>
          <div className={styles.cmp} role="table" aria-label={t("compare.title")}>
            <div role="row" style={{ display: "contents" }}>
              <div role="columnheader" className={cn(styles.l, styles.h)} />
              {items.map((p) => (
                <div role="columnheader" key={p.code} className={styles.h}>
                  {p.name}
                </div>
              ))}
            </div>
            {rows.map(([label, value]) => (
              <div role="row" key={label} style={{ display: "contents" }}>
                <div role="rowheader" className={styles.l}>
                  {label}
                </div>
                {items.map((p, i) => (
                  <div role="cell" key={p.code}>
                    {value(p, i)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </details>
    </>
  );
}
