"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, buttonVariants, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { formatDate, appLocale } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RequestUpgradeButton } from "./PlanLimitDialog";
import styles from "./plan-limits.module.css";
import { checkoutHref, fitPlan, type PublicPlans, type Usage } from "./types";

type Tone = "amber" | "blue" | "red" | "gray";
const TONE: Record<Tone, string> = { amber: styles.bAmber, blue: styles.bBlue, red: styles.bRed, gray: styles.bGray };

function Banner({ tone, title, description, action }: { tone: Tone; title: string; description: string; action?: ReactNode }) {
  return (
    <div className={cn(styles.banner, TONE[tone])} role="status">
      <b>{title}</b>
      <span>{description}</span>
      {action}
    </div>
  );
}

// "รับทราบ" ของ Member ซ่อนแบนเนอร์ถึงสิ้นวัน (เก็บในเบราว์เซอร์ ไม่ใช่ข้อมูลสำคัญ)
const dismissKey = (ws: string, id: string) => `fm_banner:${ws}:${id}:${new Date().toISOString().slice(0, 10)}`;
function isDismissed(key: string) {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * แบนเนอร์ของ Q2 ที่อ่านจาก `GET w/{ws}/usage`: ทีมโตเกินแพ็กเกจ, ทดลองใช้ใกล้หมด / หมดแล้ว, ใบแจ้งหนี้ค้างชำระ
 * วางใต้แถบบนของ WorkspaceShell · Guest ไม่เรียก API (ตอบ 403 อยู่แล้ว)
 */
export function UsageBanner({ ws, isGuest = false }: { ws: string; isGuest?: boolean }) {
  const t = useTranslations("saas-pages.banners");
  const [, rerender] = useState(0);
  const usage = useQuery({ queryKey: ["usage", ws], queryFn: () => api.get<Usage>(`/w/${encodeURIComponent(ws)}/usage`), enabled: !isGuest, retry: false, staleTime: 60_000 });
  const seatsOver = !!usage.data?.seats.over;
  const plans = useQuery({ queryKey: ["public-plans"], queryFn: () => api.get<PublicPlans>("/public/plans"), enabled: seatsOver, staleTime: 300_000 });
  const u = usage.data;
  if (!u) return null;
  const own = u.canManageBilling;
  const billing = `/work/${encodeURIComponent(ws)}/billing`;
  const ack = (id: string) => {
    const key = dismissKey(ws, id);
    if (!own && isDismissed(key)) return null;
    return own ? null : (
      <Button
        size="small"
        onClick={() => {
          try {
            sessionStorage.setItem(key, "1");
          } catch {
            /* เบราว์เซอร์ไม่ให้เก็บ: ซ่อนแค่รอบนี้ */
          }
          rerender((n) => n + 1);
        }}
      >
        {t("ack")}
      </Button>
    );
  };
  const hidden = (id: string) => !own && isDismissed(dismissKey(ws, id));
  const out: ReactNode[] = [];

  if (u.status === "past_due" && !hidden("unpaid"))
    out.push(
      <Banner
        key="unpaid"
        tone="red"
        title={t("unpaid.title")}
        description={own ? t("unpaid.owner") : t("unpaid.member")}
        action={own ? <Link className={buttonVariants({ variant: "primary", size: "small" })} href={billing}>{t("unpaid.cta")}</Link> : ack("unpaid")}
      />,
    );
  if (u.seats.over && !hidden("seats")) {
    const fit = plans.data ? fitPlan(plans.data.items.filter((p) => p.code !== "free"), u.seats.used) : undefined;
    out.push(
      <Banner
        key="seats"
        tone="amber"
        title={t("seats.title", { used: u.seats.used, plan: u.plan.name, limit: u.seats.limit ?? 0 })}
        description={own ? t("seats.owner") : t("seats.member")}
        action={
          own ? (
            <Link className={buttonVariants({ variant: "primary", size: "small" })} href={checkoutHref(ws, fit?.code)}>
              {fit && fit.code !== "enterprise" ? t("seats.ctaPlan", { plan: fit.name }) : t("seats.cta")}
            </Link>
          ) : (
            ack("seats")
          )
        }
      />,
    );
  }
  if (u.trial && !hidden("trial")) {
    const end = formatDate(u.trial.endsAt, "BE", true);
    // Owner / Admin เห็นตั้งแต่เหลือ 7 วัน · Member เห็นเฉพาะวันสุดท้าย (Q2)
    const show = u.trial.expired ? own : own ? u.trial.daysLeft <= 7 : u.trial.daysLeft <= 1;
    if (show)
      out.push(
        <Banner
          key="trial"
          tone="blue"
          title={u.trial.expired ? t("trial.expiredTitle") : t("trial.title", { plan: u.plan.name, days: u.trial.daysLeft })}
          description={u.trial.expired ? t("trial.expired") : own ? t("trial.owner", { date: end }) : t("trial.member")}
          action={own ? <Link className={buttonVariants({ variant: "primary", size: "small" })} href={checkoutHref(ws)}>{t("trial.cta")}</Link> : ack("trial")}
        />,
      );
  }
  return out.length ? <div>{out}</div> : null;
}

/** แบนเนอร์ Automation ครบโควตาของเดือน (Q2) · ใช้กับ `usage` ของ `GET p/automations` (A26) */
export function AutomationQuotaBanner({
  usage,
  canManage,
  href,
}: {
  usage: { runsThisMonth: number; quota: number };
  canManage: boolean;
  href?: string;
}) {
  const t = useTranslations("saas-pages.banners.automation");
  if (usage.runsThisMonth < usage.quota) return null;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12));
  return (
    <Banner
      tone="amber"
      title={t("title", { quota: usage.quota.toLocaleString(appLocale()) })}
      description={canManage ? t("owner", { date: formatDate(next.toISOString().slice(0, 10), "BE", true) }) : t("member")}
      action={canManage && href ? <Link className={buttonVariants({ variant: "primary", size: "small" })} href={href}>{t("cta")}</Link> : undefined}
    />
  );
}

/**
 * ฟีเจอร์ของแพ็กเกจ Team บน Free (Q2): แสดง tab ตามปกติแต่วางคำอธิบายทับเนื้อหา ไม่ซ่อน tab
 * `feature` = ชื่อที่แสดง เช่น "Gantt" · `description` = ได้อะไรจากฟีเจอร์นี้
 */
export function FeatureLock({
  ws,
  feature,
  description,
  canManage,
  children,
}: {
  ws: string;
  feature: string;
  description?: string;
  canManage: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("saas-pages.lock");
  return (
    <div className={styles.lockWrap}>
      <div aria-hidden="true" inert>
        {children}
      </div>
      <div className={styles.lock}>
        <section className={styles.lockCard} aria-labelledby="feature-lock-title">
          <span className={cn(styles.tag, styles.violet)}>{t("tag")}</span>
          <h2 id="feature-lock-title">{t("title", { feature })}</h2>
          <p className="muted">{description ?? t("description")}</p>
          <div className={styles.row}>
            {canManage ? (
              <Link className={buttonVariants({ variant: "primary" })} href={checkoutHref(ws, "team_s")}>
                {t("upgrade")}
              </Link>
            ) : (
              <RequestUpgradeButton />
            )}
            <Link className={buttonVariants()} href="/pricing">
              {t("plans")}
            </Link>
          </div>
          <span className={cn("muted", styles.small)}>{canManage ? t("ownerNote") : t("memberNote")}</span>
        </section>
      </div>
    </div>
  );
}

interface LegalItem {
  id: string;
  type: string;
  version: string;
  effectiveAt: string;
  summary: string | null;
  accepted: boolean;
}

/**
 * "เมื่อข้อกำหนดเปลี่ยน" (R4) · แสดงกับ Owner / Admin เท่านั้น (สมาชิกทั่วไปไม่ต้องกดยอมรับ)
 * กดรับทราบบันทึก `POST me/legal-acceptances` ในนาม Workspace
 */
export function LegalUpdateBanner({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("saas-pages.banners.legal");
  const tl = useTranslations("saas-pages.legal.types");
  const cache = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mine = useQuery({ queryKey: ["legal-acceptances"], queryFn: () => api.get<{ items: LegalItem[] }>("/me/legal-acceptances"), enabled: canManage, retry: false, staleTime: 300_000 });
  const pending = (mine.data?.items ?? []).filter((d) => !d.accepted && ["terms", "privacy", "dpa"].includes(d.type));
  if (!canManage || !pending.length) return null;
  const names = pending.map((d) => tl(d.type as "terms")).join(t("and"));
  const latest = pending.reduce((a, b) => (a.effectiveAt > b.effectiveAt ? a : b));
  const summary = pending.map((d) => d.summary).filter(Boolean).join(" · ");
  async function accept() {
    setBusy(true);
    try {
      for (const d of pending) await api.post("/me/legal-acceptances", { documentId: d.id, workspace: ws });
      await cache.invalidateQueries({ queryKey: ["legal-acceptances"] });
      toast({ message: t("accepted") });
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Banner
      tone="gray"
      title={t("title", { names })}
      description={[t("effective", { date: formatDate(latest.effectiveAt, "BE", true) }), summary].filter(Boolean).join(" · ")}
      action={
        <span className={styles.row}>
          <Link className={buttonVariants({ size: "small" })} href={`/legal/${pending[0].type}`} target="_blank">
            {t("read")}
          </Link>
          <Button size="small" variant="primary" disabled={busy} onClick={accept}>
            {t("accept")}
          </Button>
        </span>
      }
    />
  );
}

/** แบนเนอร์ทั้งหมดของ Workspace รวมเป็นชิ้นเดียว ให้ shell วางจุดเดียว */
export function WorkspaceBanners({ ws, role }: { ws: string; role: "owner" | "admin" | "member" | "guest" }) {
  return (
    <>
      <UsageBanner ws={ws} isGuest={role === "guest"} />
      <LegalUpdateBanner ws={ws} canManage={role === "owner" || role === "admin"} />
    </>
  );
}
