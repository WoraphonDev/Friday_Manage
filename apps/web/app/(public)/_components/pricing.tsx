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
      <CompareTable items={items} fit={fit?.code} price={price} />
    </>
  );
}

type Cell = boolean | string;
type Row = { label: string; value: (p: PublicPlan, i: number) => Cell | undefined };

/**
 * ตารางเปรียบเทียบแพ็กเกจ (แบบ A ที่ผู้ใช้เลือก 2026-11-14): 4 หมวด · คอลัมน์ที่เหมาะกับทีมตามตัวเลื่อนเป็นกรอบม่วง
 * ขีดจำกัดอ่านจาก `entitlements` ของ API (ชุดเดียวกับที่ระบบบังคับใช้) ไม่พิมพ์ตัวเลขไว้ในข้อความแปล ตัวเลขจึงไม่คลาดกัน
 * API รุ่นเก่าที่ยังไม่ส่ง entitlements: แถวที่ไม่มีค่าเลยถูกซ่อน
 */
function CompareTable({ items, fit, price }: { items: PublicPlan[]; fit?: PlanCode; price: (p: PublicPlan) => { price: string; unit: string } }) {
  const t = useTranslations("saas-pages.pricing");
  const num = (n: number) => n.toLocaleString("en-US");
  const has = (f: string) => (p: PublicPlan) => p.features.includes(f);
  const flag = (key: string) => (p: PublicPlan) => {
    const v = p.entitlements?.[key];
    return typeof v === "boolean" ? v : undefined;
  };
  // null = ไม่จำกัด (ใช้กับจำนวน) หรือ ตามสัญญา (ใช้กับพื้นที่/ระยะเก็บ) ตามความหมายใน plan-entitlements.ts
  const limit = (feature: string | null, key: string, fmt: (n: number) => string, unlimited: string) => (p: PublicPlan) => {
    const v = p.entitlements?.[key];
    if (v === undefined) return undefined;
    if (feature && p.entitlements?.[feature] === false) return false;
    return v === null ? unlimited : typeof v === "number" ? fmt(v) : undefined;
  };
  const period = (days: number) => (days % 365 === 0 ? t("compare.years", { n: days / 365 }) : t("compare.days", { n: days }));
  const prevLimit = (i: number) => items[i - 1]?.seatLimit ?? 0;

  const groups: [string, Row[]][] = [
    [
      t("compare.groups.team"),
      [
        { label: t("compare.members"), value: (p, i) => (p.seatLimit === null ? `${prevLimit(i)}+` : num(p.seatLimit)) },
        { label: t("compare.guests"), value: (p) => (typeof p.entitlements?.guests === "boolean" ? p.entitlements.guests : p.guestsFree) },
        { label: t("compare.projects"), value: (p) => (p.projectLimit === null ? t("compare.unlimited") : num(p.projectLimit)) },
        { label: t("compare.storage"), value: (p) => (p.storageGbPerMember === null ? t("compare.contract") : t("compare.storagePer", { n: p.storageGbPerMember })) },
      ],
    ],
    [
      t("compare.groups.plan"),
      [
        { label: "Kanban, Table, Calendar", value: has("kanban") },
        { label: "Gantt, Workload, Sprint", value: has("gantt") },
        { label: t("compare.reports"), value: has("reports") },
        { label: t("compare.excel"), value: has("import_excel") },
      ],
    ],
    [
      t("compare.groups.connect"),
      [
        { label: "Automation", value: limit("automation", "automation_runs", (n) => t("compare.perMonth", { n: num(n) }), t("compare.unlimited")) },
        { label: t("compare.line"), value: has("line_oa") },
        { label: t("compare.git"), value: has("git_integration") },
        { label: "API", value: limit("api", "api_rpm", (n) => t("compare.perMinute", { n: num(n) }), t("compare.unlimited")) },
      ],
    ],
    [
      t("compare.groups.security"),
      [
        { label: "SSO / SAML", value: flag("sso") },
        { label: t("compare.history"), value: limit(null, "history_days", period, t("compare.contract")) },
        { label: t("compare.sla"), value: flag("sla") },
      ],
    ],
  ];
  const visible = groups
    .map(([g, rows]) => [g, rows.filter((r) => items.some((p, i) => r.value(p, i) !== undefined))] as const)
    .filter(([, rows]) => rows.length > 0);
  const hot = (p: PublicPlan) => (p.code === fit ? styles.cmpHot : undefined);
  const show = (v: Cell | undefined) =>
    v === true ? (
      <span className={styles.cmpYes} role="img" aria-label={t("compare.yes")}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    ) : v === false || v === undefined ? (
      <span className={styles.cmpNo} role="img" aria-label={t("compare.no")}>
        –
      </span>
    ) : (
      v
    );

  return (
    <details className={styles.cmpBox}>
      <summary>{t("compare.title")}</summary>
      <div className={styles.cmpScroll}>
        <table className={styles.cmp} aria-label={t("compare.title")}>
          <thead>
            <tr>
              <td />
              {items.map((p) => {
                const pr = price(p);
                return (
                  <th key={p.code} scope="col" className={hot(p)}>
                    {p.code === fit && <span className={styles.cmpTag}>{t("fitTag")}</span>}
                    <span className={styles.cmpName}>{p.name}</span>
                    <span className={styles.cmpPrice}>
                      {pr.price} {pr.unit}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {visible.map(([group, rows]) => (
            <tbody key={group}>
              <tr className={styles.cmpGroup}>
                <th scope="rowgroup">{group}</th>
                {items.map((p) => (
                  <td key={p.code} className={hot(p)} aria-hidden="true" />
                ))}
              </tr>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {items.map((p, i) => (
                    <td key={p.code} className={hot(p)}>
                      {show(row.value(p, i))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </details>
  );
}
