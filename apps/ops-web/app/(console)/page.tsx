"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import { ErrorBlock, Notice, PageHead, TableSkeleton } from "@/components/kit";
import type { TaskKey } from "@/components/shell/nav";
import { buttonClass, LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { ColumnChart, HBars } from "./business/_parts/charts";
import { PLAN_LABEL, planLabel, useFmt } from "./workspaces/_parts/format";
import { FeedCard, UsageCard } from "./_main/UsageFeed";

interface Movement {
  count: number;
  mrrDelta: number;
}
interface MainOverview {
  month: string;
  money: {
    mrr: number;
    arr: number;
    payingWorkspaces: number;
    arpa: number;
    movement: Partial<Record<"new" | "upgrade" | "downgrade" | "seats_up" | "seats_down" | "cycle_change" | "cancel" | "reactivate" | "churn_payment", Movement>>;
    netNewMrr: number;
    churn: { logoPct: number | null; revenuePct: number | null; paymentFailures: number };
    nrrPct: number | null;
    startMrr?: number;
    mrrHistory?: { month: string; mrrSatang: number }[];
  } | null;
  trialing: number;
  tasks: Record<TaskKey, number>;
}
interface Row {
  id: string;
  name: string;
  plan: string | null;
  seats: number;
  active30: number;
  health: number;
  mrr: number | null;
  paymentState: "ok" | "overdue";
  healthParts?: { usage: number; payment: number; support: number; growth: number };
  overdueInvoices?: number;
  openTickets?: number;
  seats30dAgo?: number;
}
/** น้ำหนักคะแนนสุขภาพ (ตรงกับ ops-api `healthScore`) · สาเหตุหลัก = ส่วนที่ทำให้เสียคะแนนมากที่สุด */
const WEIGHT = { usage: 0.4, payment: 0.25, support: 0.2, growth: 0.15 } as const;
function mainIssue(r: Row): keyof typeof WEIGHT | null {
  if (!r.healthParts) return r.paymentState === "overdue" ? "payment" : r.seats > 0 && r.active30 / r.seats < 0.5 ? "usage" : null;
  const parts = r.healthParts;
  const [key, lost] = (Object.keys(WEIGHT) as (keyof typeof WEIGHT)[]).map((k) => [k, WEIGHT[k] * (100 - parts[k])] as const).sort((a, b) => b[1] - a[1])[0]!;
  return lost > 0 ? key : null;
}

/** งานวันนี้ตามบทบาท (ตรงกับแผงแจ้งเตือน G2) */
const TASKS: { task: TaskKey; who: "approvals" | "money" | "support" | "engineer" | "privacy"; roles: Parameters<typeof hasAny>[1][]; href: string; tone: "bad" | "warn" | "inf" }[] = [
  { task: "paymentExceptions", who: "money", roles: ["owner", "finance"], href: "/payments", tone: "bad" },
  { task: "slipsToReview", who: "money", roles: ["owner", "finance"], href: "/payments", tone: "warn" },
  { task: "invoicesOverdue", who: "money", roles: ["owner", "finance"], href: "/payments?tab=overdue", tone: "bad" },
  { task: "approvals", who: "approvals", roles: ["owner"], href: "/refunds", tone: "inf" },
  { task: "ticketsBreached", who: "support", roles: ["owner", "support"], href: "/support", tone: "bad" },
  { task: "ticketsUnassigned", who: "support", roles: ["owner", "support"], href: "/support", tone: "warn" },
  { task: "trialEndingSoon", who: "support", roles: ["owner", "support"], href: "/workspaces?status=trialing", tone: "warn" },
  { task: "incidentsOpen", who: "engineer", roles: ["owner", "engineer", "support"], href: "/incidents", tone: "bad" },
  { task: "privacyDueSoon", who: "privacy", roles: ["owner", "support"], href: "/privacy", tone: "warn" },
  { task: "breachesOpen", who: "privacy", roles: ["owner", "engineer"], href: "/privacy", tone: "bad" },
];
const PLANS = Object.keys(PLAN_LABEL);
const monthLabel = (f: ReturnType<typeof useFormatter>, m: string) => f.dateTime(new Date(`${m}-15T00:00:00Z`), { month: "short" });

/** หน้า 1 · ภาพรวม (Main.dc.html) · ตัวเลขเงินเฉพาะ Owner / การเงิน / ผู้ตรวจ · งานวันนี้ตามบทบาท */
export default function MainPage() {
  const t = useTranslations("ob.main");
  const f = useFormatter();
  const me = useMe().data;
  const q = useQuery({ queryKey: ["ops", "overview"], queryFn: () => api.get<MainOverview>("/overview"), staleTime: 60_000, refetchInterval: 120_000 });
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const now = new Date();
  return (
    <>
      <PageHead title={t("title")} desc={t("updated", { date: f.dateTime(now, { dateStyle: "full" }), time: f.dateTime(new Date(q.dataUpdatedAt), { timeStyle: "short" }) })} />
      <Kpis d={d} />
      <div className="grid-main">
        <div className="stack">
          {d.money && <MrrCard d={d} />}
          {me && hasAny(me, "owner", "support", "finance", "auditor") && <PlansAndRisk money={!!d.money} />}
        </div>
        <div className="stack">
          <Todo tasks={d.tasks} />
        </div>
      </div>
      <UsageCard />
      <div className={me && hasAny(me, "owner", "engineer") ? "grid-feed" : undefined}>
        {me && hasAny(me, "owner", "engineer") && <SystemCard />}
        <FeedCard />
      </div>
    </>
  );
}

function Kpis({ d }: { d: MainOverview }) {
  const t = useTranslations("ob.main.kpi");
  const fmt = useFmt();
  const m = d.money;
  const start = m?.startMrr ?? (m ? m.mrr - m.netNewMrr : 0);
  const growth = m && start > 0 ? Math.round(((m.mrr - start) / start) * 1000) / 10 : null;
  const pct = (n: number | null | undefined) => (n == null ? t("na") : `${n}%`);
  return (
    <section className="stats" aria-label="KPI">
      {m && (
        <>
          <div className="stat">
            <span className="muted small">{t("mrr")}</span>
            <b>{fmt.money(m.mrr)}</b>
            <span className="small">
              {growth != null && <span className={growth >= 0 ? "pill ok" : "pill bad"}>{`${growth >= 0 ? "+" : ""}${growth}%`}</span>} <span className="muted">{t("mrrNote", { start: fmt.money(start) })}</span>
            </span>
          </div>
          <div className="stat">
            <span className="muted small">{t("arr")}</span>
            <b>{fmt.money(m.arr)}</b>
            <span className="muted small">{t("arrNote")}</span>
          </div>
          <div className="stat">
            <span className="muted small">{t("paying")}</span>
            <b>{fmt.num(m.payingWorkspaces)}</b>
            <span className="muted small">{t("payingNote", { arpa: fmt.money(m.arpa) })}</span>
          </div>
        </>
      )}
      <div className="stat">
        <span className="muted small">{t("trialing")}</span>
        <b>{fmt.num(d.trialing)}</b>
        <span className="small">
          {d.tasks.trialEndingSoon > 0 && <span className="pill warn">{t("trialEnding", { n: d.tasks.trialEndingSoon })}</span>} <span className="muted">{t("trialNote")}</span>
        </span>
      </div>
      {m && (
        <>
          <div className={(m.churn.revenuePct ?? 0) > 3 ? "stat stat-warn" : "stat"}>
            <span className="muted small">{t("churn")}</span>
            <b>{pct(m.churn.revenuePct)}</b>
            <span className="muted small">{t("churnNote", { logo: pct(m.churn.logoPct), revenue: pct(m.churn.revenuePct) })}</span>
          </div>
          <div className="stat">
            <span className="muted small">{t("nrr")}</span>
            <b>{pct(m.nrrPct)}</b>
            <span className="muted small">{t("nrrNote")}</span>
          </div>
        </>
      )}
    </section>
  );
}

/** MRR 12 เดือน (แท่งเดียวสี · เดือนนี้เข้ม) + ความเคลื่อนไหวเดือนนี้ */
function MrrCard({ d }: { d: MainOverview }) {
  const t = useTranslations("ob.main");
  const f = useFormatter();
  const fmt = useFmt();
  const m = d.money!;
  const history = m.mrrHistory ?? [{ month: d.month, mrrSatang: m.mrr }];
  const mv = m.movement;
  const sum = (...k: (keyof typeof mv)[]) => k.reduce((n, x) => n + (mv[x]?.mrrDelta ?? 0), 0);
  const moves: { key: string; value: number }[] = [
    { key: "new", value: sum("new") },
    { key: "expansion", value: sum("upgrade", "seats_up") },
    { key: "contraction", value: sum("downgrade", "seats_down") },
    { key: "churn", value: sum("cancel", "churn_payment") },
    { key: "reactivate", value: sum("reactivate") },
  ].filter((x) => x.value !== 0 || x.key !== "reactivate");
  const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt.money(Math.abs(n))}`;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("mrrChart")}</h2>
        <span className="card-sub">{t("mrrChartSub")}</span>
        <span className="spacer" />
        <Link className="link-button small" href="/payments?tab=revenue">
          {t("allRevenue")}
        </Link>
      </div>
      <ColumnChart
        label={t("mrrChart")}
        cols={history.map((h, i) => ({ label: monthLabel(f, h.month), value: h.mrrSatang, display: fmt.money(h.mrrSatang), tone: i === history.length - 1 ? "primary" : "soft", labelled: i === history.length - 1 }))}
      />
      <h3 className="card-title small">{t("movement")}</h3>
      <div className="row" style={{ gap: 18 }}>
        {moves.map((x) => (
          <span key={x.key} className="stack" style={{ gap: 0 }}>
            <span className="muted small">{t(`moves.${x.key}` as "moves.new")}</span>
            <b className="mono" style={{ color: x.value > 0 ? "var(--success-text)" : x.value < 0 ? "var(--danger-text)" : undefined }}>
              {signed(x.value)}
            </b>
          </span>
        ))}
        <span className="stack" style={{ gap: 0 }}>
          <span className="muted small">{t("moves.net")}</span>
          <b className="mono">{signed(m.netNewMrr)}</b>
        </span>
      </div>
    </section>
  );
}

function Todo({ tasks }: { tasks: MainOverview["tasks"] }) {
  const t = useTranslations("ob.main");
  const me = useMe().data;
  const items = TASKS.filter((x) => hasAny(me, ...x.roles) && (tasks[x.task] ?? 0) > 0);
  const total = items.reduce((n, x) => n + tasks[x.task], 0);
  return (
    <section className="card" aria-label={t("todo")}>
      <div className="card-head">
        <h2 className="card-title">{t("todo")}</h2>
        {total > 0 && <span className="pill bad">{total}</span>}
      </div>
      {!items.length ? (
        <Notice tone="ok" title={t("todoEmpty")} />
      ) : (
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }}>
          {items.map((x) => (
            <li key={x.task}>
              <Link className="menu-item" href={x.href} style={{ alignItems: "flex-start", border: "1px solid var(--border)" }}>
                <span className={`pill ${x.tone}`}>{tasks[x.task]}</span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span>{t(`tasks.${x.task}`)}</span>
                  <span className="muted small">{t(`who.${x.who}`)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** ลูกค้าตามแพ็กเกจ (นับจากรายการ Workspace) · ลูกค้าเสี่ยงยกเลิก (สุขภาพ < 50) */
function PlansAndRisk({ money }: { money: boolean }) {
  const t = useTranslations("ob.main");
  const fmt = useFmt();
  const plans = useQuery({
    queryKey: ["ops", "workspaces", "plan-counts"],
    queryFn: async () => Promise.all(PLANS.map(async (p) => ({ plan: p, total: (await api.get<{ total: number }>(`/workspaces?plan=${p}&limit=1`)).total }))),
    staleTime: 300_000,
  });
  const risky = useQuery({ queryKey: ["ops", "workspaces", "risky"], queryFn: () => api.get<{ items: Row[] }>("/workspaces?sort=health&limit=8&status=active"), staleTime: 300_000 });
  const low = (risky.data?.items ?? []).filter((r) => r.health < 50).slice(0, 5);
  const reason = (r: Row) => {
    switch (mainIssue(r)) {
      case "payment":
        return r.overdueInvoices ? t("reason.overdueN", { n: r.overdueInvoices }) : t("reason.overdue");
      case "usage":
        return t("reason.inactive", { active: r.active30, seats: r.seats });
      case "support":
        return t("reason.tickets", { n: r.openTickets ?? 0 });
      case "growth":
        return r.seats30dAgo && r.seats30dAgo > r.seats ? t("reason.shrinking", { from: r.seats30dAgo, to: r.seats }) : t("reason.other");
      default:
        return t("reason.other");
    }
  };
  return (
    <div className="grid-2">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("plans")}</h2>
        </div>
        {plans.isPending ? (
          <TableSkeleton rows={5} cols={2} />
        ) : plans.error ? (
          <ErrorBlock error={plans.error} retry={() => void plans.refetch()} />
        ) : (
          <HBars label={t("plans")} rows={plans.data.map((p, i) => ({ key: p.plan, label: planLabel(p.plan), value: p.total, display: fmt.num(p.total), tone: i === 0 ? "neutral" : "primary" }))} />
        )}
        <p className="muted small">{t("plansNote")}</p>
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("risky")}</h2>
          <span className="card-sub">{t("riskySub")}</span>
          <span className="spacer" />
          <Link className="link-button small" href="/workspaces?sort=health">
            {t("seeAll")}
          </Link>
        </div>
        {risky.isPending ? (
          <TableSkeleton rows={4} cols={4} />
        ) : risky.error ? (
          <ErrorBlock error={risky.error} retry={() => void risky.refetch()} />
        ) : !low.length ? (
          <Notice tone="ok" title={t("riskyEmpty")} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("riskCol.ws")}</th>
                  <th>{t("riskCol.health")}</th>
                  <th>{t("riskCol.reason")}</th>
                  {money && <th className="num">{t("riskCol.mrr")}</th>}
                </tr>
              </thead>
              <tbody>
                {low.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/workspaces/${r.id}`}>{r.name}</Link>
                      <div className="muted small">{planLabel(r.plan)}</div>
                    </td>
                    <td>
                      <span className={r.health < 40 ? "pill bad" : "pill warn"}>{r.health}</span>
                    </td>
                    <td className="small">{reason(r)}</td>
                    {money && <td className="num">{fmt.money(r.mrr)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface SystemStatus {
  api: { probes: number; uptimePct: number | null; p95Ms: number | null; last: { ok: boolean } | null };
  database: { ok: boolean; ms: number };
  queue: { configured: false } | { configured: true; failed: number };
  deliveries: { channel: string; total: number; sent: number; failed: number }[];
}
/** สถานะระบบย่อ (วิศวกร / Owner) */
function SystemCard() {
  const t = useTranslations("ob.main");
  const q = useQuery({ queryKey: ["ops", "system"], queryFn: () => api.get<SystemStatus>("/system/status"), refetchInterval: 60_000 });
  const rate = (ch: string) => {
    const x = q.data?.deliveries.find((d) => d.channel === ch);
    return x && x.total ? `${Math.round((x.sent / x.total) * 1000) / 10}%` : t("noData");
  };
  return (
    <section className="card" aria-label={t("system")}>
      <div className="card-head">
        <h2 className="card-title">{t("system")}</h2>
        <span className="spacer" />
        <Link className={buttonClass("ghost", "small")} href="/system">
          {t("systemLink")}
        </Link>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={3} cols={2} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.api.last ? <p className="muted small">{t("noProbe")}</p> : q.data.api.last.ok ? <Notice tone="ok" title={t("systemOk")} /> : <Notice tone="bad" title={t("systemDown")} />}
          <table className="tbl">
            <tbody>
              <tr>
                <td className="muted">{t("health.uptime")}</td>
                <td className="num">{q.data.api.uptimePct == null ? t("noData") : `${q.data.api.uptimePct}%`}</td>
              </tr>
              <tr>
                <td className="muted">{t("health.p95")}</td>
                <td className="num">{q.data.api.p95Ms == null ? t("noData") : t("ms", { n: q.data.api.p95Ms })}</td>
              </tr>
              <tr>
                <td className="muted">{t("health.db")}</td>
                <td className="num">{t("ms", { n: q.data.database.ms })}</td>
              </tr>
              <tr>
                <td className="muted">{t("health.queue")}</td>
                <td className="num">{q.data.queue.configured ? t("jobs", { n: q.data.queue.failed }) : t("noData")}</td>
              </tr>
              <tr>
                <td className="muted">{t("health.email")}</td>
                <td className="num">{rate("email")}</td>
              </tr>
              <tr>
                <td className="muted">{t("health.line")}</td>
                <td className="num">{rate("line")}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
