"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { hasAny } from "@/components/access";
import { ErrorBlock, NoAccess, Notice, PageHead, Seg } from "@/components/kit";
import { Button, errorToast, LoadingState, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import { cohortShade, ColumnChart, HBars } from "./_parts/charts";
import { CostSettings, MarketingCosts } from "./_parts/Settings";
import type { Business, Costs, Period } from "./_parts/types";

const monthText = (f: ReturnType<typeof useFormatter>, m: string, year = false) => f.dateTime(new Date(`${m}-15T00:00:00Z`), year ? { month: "short", year: "numeric" } : { month: "short" });
const head = { padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap" as const };

/** หน้า 2 · ธุรกิจและกำไร (Business.dc.html · B9 · B10) · Owner / การเงิน แก้ต้นทุนได้ · ผู้ตรวจอ่าน */
export function BusinessPage() {
  const t = useTranslations("ob.biz");
  const f = useFormatter();
  const me = useMe().data;
  const read = hasAny(me, "owner", "finance", "auditor");
  const edit = hasAny(me, "owner", "finance");
  const toast = useToast();
  const cache = useQueryClient();
  const [period, setPeriod] = useState<Period>("quarter");
  const q = useQuery({ queryKey: ["ops", "business", period], queryFn: () => api.get<Business>(`/business?period=${period}`), enabled: !!me && read, placeholderData: keepPreviousData });
  const overview = useQuery({ queryKey: ["ops", "overview"], queryFn: () => api.get<{ money: { nrrPct: number | null } | null }>("/overview"), enabled: !!me && read, staleTime: 60_000 });
  const [modal, setModal] = useState<"costs" | "marketing" | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.get<Business>(`/business?refresh=true&period=${period}`),
    onSuccess: (d) => (cache.setQueryData(["ops", "business", period], d), toast(t("refreshed"))),
    onError: (e) => toast(errorToast(e)),
  });
  if (me && !read) return <NoAccess need={["owner", "finance", "auditor"]} />;
  return (
    <>
      <PageHead
        title={t("title")}
        desc={
          <>
            {t("desc")}
            {q.data && <span className="muted"> · {t("computed", { time: f.dateTime(new Date(q.data.computedAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>}
          </>
        }
        actions={
          <>
            <Seg label={t("period")} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(`periods.${p}`) }))} />
            <Button disabled={!q.data} onClick={() => q.data && downloadCsv(q.data, t)}>
              <Download size={16} /> {t("export")}
            </Button>
            {edit && <Button onClick={() => setModal("marketing")}>{t("marketing")}</Button>}
            {edit && (
              <Button variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                <RefreshCw size={16} /> {t("refresh")}
              </Button>
            )}
          </>
        }
      />
      {q.isPending ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <Kpis b={q.data} nrr={overview.data?.money?.nrrPct ?? null} />
          <div className="grid-main">
            <PlanMargins b={q.data} />
            <CostCard b={q.data} edit={edit} onSettings={() => setModal("costs")} />
          </div>
          <Losers b={q.data} />
          <div className="grid-2">
            <Funnel b={q.data} />
            <Cohorts b={q.data} />
          </div>
          <Channels b={q.data} />
          <div className="grid-2">
            <Reasons b={q.data} />
            <Features b={q.data} />
          </div>
          <div className="grid-main">
            <Upgrade b={q.data} />
            <Cash b={q.data} />
          </div>
        </>
      )}
      {modal === "costs" && <CostSettings onClose={() => setModal(null)} />}
      {modal === "marketing" && <MarketingCosts onClose={() => setModal(null)} />}
    </>
  );
}

function Kpis({ b, nrr }: { b: Business; nrr: number | null }) {
  const t = useTranslations("ob.biz.kpi");
  const fmt = useFmt();
  const spend = b.channels.reduce((n, c) => n + c.spendSatang, 0);
  const fresh = b.channels.reduce((n, c) => n + c.newPaying, 0);
  const cac = fresh > 0 ? Math.round(spend / fresh) : null;
  const unitMargin = b.arpaSatang * ((b.margin.marginPct ?? 0) / 100);
  const payback = cac != null && unitMargin > 0 ? Math.round((cac / unitMargin) * 10) / 10 : null;
  const tiles = [
    { k: "mrr", value: fmt.money(b.mrrSatang), note: t("mrrNote", { n: b.payingWorkspaces }) },
    {
      k: "margin",
      value: b.margin.marginPct == null ? "—" : `${b.margin.marginPct}%`,
      note: t("marginNote", { amount: fmt.money(b.margin.revenueSatang - b.margin.costSatang) }),
      tone: b.margin.marginPct != null && b.margin.marginPct < 70 ? "warn" : undefined,
    },
    { k: "nrr", value: nrr == null ? "—" : `${nrr}%`, note: t("nrrNote") },
    { k: "cac", value: fmt.money(cac), note: t("cacNote", { days: b.funnel.windowDays }) },
    { k: "payback", value: payback == null ? "—" : t("paybackValue", { n: payback }), note: t("paybackNote"), tone: payback != null ? (payback < 12 ? "ok" : "warn") : undefined },
    { k: "trial", value: b.trialConversion.pct == null ? "—" : `${b.trialConversion.pct}%`, note: t("trialNote", { converted: b.trialConversion.converted, ended: b.trialConversion.ended, days: b.funnel.windowDays }) },
  ] as const;
  return (
    <section className="stats" aria-label="KPI">
      {tiles.map((x) => (
        <div key={x.k} className={"tone" in x && x.tone ? `stat stat-${x.tone}` : "stat"}>
          <span className="muted small">{t(x.k)}</span>
          <b>{x.value}</b>
          <span className="muted small">{x.note}</span>
        </div>
      ))}
    </section>
  );
}

function PlanMargins({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const fmt = useFmt();
  const loss = (plan: string) => b.customers.unprofitable.filter((c) => c.plan === plan).length;
  const rows = b.margin.byPlan;
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={head}>
        <h2 className="card-title">{t("plans")}</h2>
        <span className="card-sub">{t("plansSub")}</span>
      </div>
      {!rows.length ? (
        <p className="muted small" style={{ padding: 16 }}>
          {t("noPlans")}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("planCol.plan")}</th>
                <th className="num">{t("planCol.customers")}</th>
                <th className="num">{t("planCol.mrr")}</th>
                <th className="num">{t("planCol.cost")}</th>
                <th style={{ minWidth: 160 }}>{t("planCol.margin")}</th>
                <th>{t("planCol.loss")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.plan}>
                  <td>{planLabel(p.plan)}</td>
                  <td className="num">{fmt.num(p.customers)}</td>
                  <td className="num">{fmt.money(p.revenueSatang)}</td>
                  <td className="num">{fmt.money(p.costSatang)}</td>
                  <td>
                    <span className="row" style={{ flexWrap: "nowrap" }} title={`${planLabel(p.plan)} · ${p.marginPct ?? "—"}%`}>
                      <span className="hbar-track" style={{ flex: 1 }}>
                        <span className={`hbar ${p.marginPct == null || p.marginPct < 0 ? "hbar-bad" : p.marginPct >= 80 ? "hbar-primary" : "hbar-warn"}`} style={{ width: `${Math.max(0, Math.min(100, p.marginPct ?? 0))}%` }} />
                      </span>
                      <b className="small">{p.marginPct == null ? "—" : `${p.marginPct}%`}</b>
                    </span>
                  </td>
                  <td>{loss(p.plan) ? <span className="pill bad">{t("lossN", { n: loss(p.plan) })}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>{t("total")}</b>
                </td>
                <td className="num">
                  <b>{fmt.num(b.payingWorkspaces)}</b>
                </td>
                <td className="num">
                  <b>{fmt.money(b.margin.revenueSatang)}</b>
                </td>
                <td className="num">
                  <b>{fmt.money(b.margin.costSatang)}</b>
                </td>
                <td>
                  <b>{b.margin.marginPct == null ? "—" : `${b.margin.marginPct}%`}</b>
                </td>
                <td>{b.customers.unprofitable.length ? <span className="pill bad">{t("lossN", { n: b.customers.unprofitable.length })}</span> : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** ต้นทุนการให้บริการ: ส่วนกลาง vs ขึ้นตามการใช้ · ต้นทุนต่อหน่วยที่ใช้อยู่ · ปุ่มตั้งค่า (B9) */
function CostCard({ b, edit, onSettings }: { b: Business; edit: boolean; onSettings: () => void }) {
  const t = useTranslations("ob.biz");
  const tb = useTranslations("ob.b9");
  const f = useFormatter();
  const fmt = useFmt();
  const costs = useQuery({ queryKey: ["ops", "business", "costs"], queryFn: () => api.get<Costs>("/costs") });
  const infra = b.payingWorkspaces ? Math.min(b.margin.infraSatang, b.margin.costSatang) : 0;
  const variable = Math.max(0, b.margin.costSatang - infra);
  const pct = b.margin.revenueSatang > 0 ? `${Math.round((b.margin.costSatang / b.margin.revenueSatang) * 100)}%` : "—";
  const rate = (r: NonNullable<Costs["rates"][number]["current"]>, kind: "pct" | "unit") => (kind === "pct" ? `${Number(r.pct)}%` : `฿${f.number(Number(r.unitCostSatang) / 100, { maximumFractionDigits: 4 })}`);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("costs")}</h2>
        <span className="spacer" />
        {edit && (
          <Button size="small" onClick={onSettings}>
            <Settings2 size={14} /> {t("setCosts")}
          </Button>
        )}
      </div>
      <span className="muted small">{t("costsSub", { amount: fmt.money(b.margin.costSatang), pct })}</span>
      <HBars
        label={t("costs")}
        rows={
          b.margin.breakdown
            ? [
                { key: "infra", label: t("infra"), sub: b.margin.infraMonth ? t("infraBasis", { month: monthText(f, b.margin.infraMonth, true) }) : t("infraNone"), value: b.margin.breakdown.infraSatang, display: fmt.money(b.margin.breakdown.infraSatang), tone: "primary" as const },
                ...(["line", "email", "storage", "paymentFees"] as const).map((k) => ({ key: k, label: t(`costParts.${k}`), value: b.margin.breakdown![`${k}Satang`], display: fmt.money(b.margin.breakdown![`${k}Satang`]), tone: "soft" as const })),
              ]
            : [
                { key: "infra", label: t("infra"), sub: b.margin.infraMonth ? t("infraBasis", { month: monthText(f, b.margin.infraMonth, true) }) : t("infraNone"), value: infra, display: fmt.money(infra), tone: "primary" as const },
                { key: "variable", label: t("variable"), sub: t("variableBasis"), value: variable, display: fmt.money(variable), tone: "soft" as const },
              ]
        }
      />
      <h3 className="card-title small">{t("rates")}</h3>
      {costs.data && (
        <table className="tbl">
          <tbody>
            {costs.data.rates.map((r) => (
              <tr key={r.resource}>
                <td className="small">{tb(`resources.${r.resource}`)}</td>
                <td className="num small">{r.current ? rate(r.current, r.kind) : <span className="muted">{t("noRate")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Losers({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const fmt = useFmt();
  const rows = b.customers.unprofitable;
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={head}>
        <h2 className="card-title">{t("losers")}</h2>
        {rows.length > 0 && <span className="pill bad">{rows.length}</span>}
        <span className="card-sub">{t("losersSub")}</span>
      </div>
      {!rows.length ? (
        <div style={{ padding: 16 }}>
          <Notice tone="ok" title={t("losersEmpty")} />
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("loserCol.ws")}</th>
                <th>{t("loserCol.plan")}</th>
                <th className="num">{t("loserCol.rev")}</th>
                <th className="num">{t("loserCol.cost")}</th>
                <th className="num">{t("loserCol.gross")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.workspace.id}>
                  <td>{c.workspace.name ?? c.workspace.id.slice(0, 8)}</td>
                  <td>{planLabel(c.plan)}</td>
                  <td className="num">{fmt.money(c.revenueSatang)}</td>
                  <td className="num">{fmt.money(c.costSatang)}</td>
                  <td className="num" style={{ color: "var(--danger-text)" }}>
                    {fmt.money(c.grossSatang)}
                  </td>
                  <td>
                    <Link className="link-button small" href={`/workspaces/${c.workspace.id}`}>
                      {t("open")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const FUNNEL = ["signups", "emailVerified", "firstProject", "secondMember", "activated", "paid"] as const;
export function Funnel({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const fmt = useFmt();
  const n = (k: (typeof FUNNEL)[number]) => Number(b.funnel[k] ?? 0);
  const drops = FUNNEL.map((k, i) => (i && n(FUNNEL[i - 1]) > 0 ? Math.round((1 - n(k) / n(FUNNEL[i - 1])) * 100) : 0));
  const worst = Math.max(...drops);
  return (
    <section className="card" id="funnel">
      <div className="card-head">
        <h2 className="card-title">{t("funnel")}</h2>
        <span className="card-sub">{t("funnelSub", { days: b.funnel.windowDays })}</span>
      </div>
      <HBars
        label={t("funnel")}
        rows={FUNNEL.map((k, i) => ({
          key: k,
          label: t(`funnelSteps.${k}`),
          value: n(k),
          of: n("signups"),
          display: fmt.num(n(k)),
          tone: i && drops[i] === worst && worst > 0 ? "warn" : "primary",
          note: i && n(FUNNEL[i - 1]) > 0 ? `−${drops[i]}%` : undefined,
        }))}
      />
      <p className="muted small">{t("activatedDef")}</p>
    </section>
  );
}

export function Cohorts({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const f = useFormatter();
  const cols = Math.min(6, Math.max(1, ...b.cohorts.map((c) => c.retention.length)));
  const rows = b.cohorts.slice(-6);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("cohorts")}</h2>
        <span className="card-sub">{t("cohortsSub")}</span>
      </div>
      {!rows.length ? (
        <p className="muted small">{t("cohortsEmpty")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl cohort" aria-label={t("cohorts")}>
            <thead>
              <tr>
                <th>{t("cohortStart")}</th>
                <th className="num">{t("cohortN")}</th>
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i} className="num">
                    {i === 0 ? t("cohortMonth", { n: 0 }) : i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.month}>
                  <td className="small">{monthText(f, c.month, true)}</td>
                  <td className="num small">{c.customers}</td>
                  {Array.from({ length: cols }, (_, i) => {
                    const v = c.retention[i];
                    return v == null ? (
                      <td key={i} className="cell" style={{ background: "var(--surface-2)" }} />
                    ) : (
                      <td key={i} className="cell" style={cohortShade(v)} title={t("cohortTip", { start: monthText(f, c.month, true), n: i, pct: v })}>
                        {v}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Channels({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const fmt = useFmt();
  const label = (s: string) => (t.has(`sources.${s}` as "sources.direct") ? t(`sources.${s}` as "sources.direct") : s);
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={head}>
        <h2 className="card-title">{t("channels")}</h2>
        <span className="card-sub">{t("channelsSub", { period: t(`periods.${b.period ?? "quarter"}`) })}</span>
      </div>
      {!b.channels.length ? (
        <p className="muted small" style={{ padding: 16 }}>
          {t("channelsEmpty")}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("chCol.source")}</th>
                <th className="num">{t("chCol.signups")}</th>
                <th className="num">{t("chCol.conversion")}</th>
                <th className="num">{t("chCol.paid")}</th>
                <th className="num">{t("chCol.spend")}</th>
                <th className="num">{t("chCol.cac")}</th>
                <th className="num">{t("chCol.payback")}</th>
                <th>{t("chCol.ratio")}</th>
              </tr>
            </thead>
            <tbody>
              {[...b.channels]
                .sort((x, y) => y.newPaying - x.newPaying)
                .map((c) => {
                  const ratio = b.ltvSatang != null && c.cacSatang ? Math.round((b.ltvSatang / c.cacSatang) * 10) / 10 : null;
                  return (
                    <tr key={c.source}>
                      <td>{label(c.source)}</td>
                      <td className="num">{c.signups ?? "—"}</td>
                      <td className="num">{c.conversionPct == null ? "—" : `${c.conversionPct}%`}</td>
                      <td className="num">{c.newPaying}</td>
                      <td className="num">{fmt.money(c.spendSatang)}</td>
                      <td className="num">{c.cacSatang == null ? "—" : fmt.money(c.cacSatang)}</td>
                      <td className="num">{c.paybackMonths == null ? "—" : `${c.paybackMonths}`}</td>
                      <td>{c.spendSatang === 0 && c.newPaying > 0 ? <span className="pill inf">{t("free")}</span> : ratio == null ? <span className="muted">—</span> : <span className={ratio >= 3 ? "pill ok" : "pill warn"}>{`${ratio}×`}</span>}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ padding: "8px 16px 14px", margin: 0 }}>
        {b.ltvSatang == null ? t("ltvNone") : t("ltv", { amount: fmt.money(b.ltvSatang), pct: b.monthlyRevenueChurnPct })}
      </p>
    </section>
  );
}

export function Reasons({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const total = b.cancellationReasons.reduce((n, r) => n + r.n, 0);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("reasons")}</h2>
        <span className="card-sub">{t("reasonsSub", { n: total, days: b.funnel.windowDays })}</span>
      </div>
      {!total ? (
        <p className="muted small">{t("reasonsEmpty")}</p>
      ) : (
        <HBars
          label={t("reasons")}
          rows={b.cancellationReasons.map((r) => ({
            key: r.reason,
            label: t.has(`reasonLabels.${r.reason}` as "reasonLabels.other") ? t(`reasonLabels.${r.reason}` as "reasonLabels.other") : r.reason,
            sub: r.kept ? t("kept", { n: r.kept }) : undefined,
            value: r.n,
            display: `${Math.round((r.n / total) * 100)}%`,
            tone: "primary",
          }))}
        />
      )}
    </section>
  );
}

export function Features({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  return (
    <section className="card" id="adoption">
      <div className="card-head">
        <h2 className="card-title">{t("features")}</h2>
        <span className="card-sub">{t("featuresSub")}</span>
      </div>
      {!b.featureAdoption.length ? (
        <p className="muted small">{t("featuresEmpty")}</p>
      ) : (
        <HBars
          label={t("features")}
          rows={b.featureAdoption.map((x) => ({
            key: x.feature,
            label: t.has(`featureLabels.${x.feature}` as "featureLabels.table") ? t(`featureLabels.${x.feature}` as "featureLabels.table") : x.feature,
            value: x.pct ?? 0,
            of: 100,
            display: x.pct == null ? "—" : `${x.pct}%`,
            tone: "primary",
          }))}
        />
      )}
    </section>
  );
}

export function Upgrade({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={head}>
        <h2 className="card-title">{t("upgrade")}</h2>
        {b.upgradeReady.length > 0 && <span className="pill ok">{b.upgradeReady.length}</span>}
        <span className="card-sub">{t("upgradeSub")}</span>
      </div>
      {!b.upgradeReady.length ? (
        <p className="muted small" style={{ padding: 16 }}>
          {t("upgradeEmpty")}
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("upCol.ws")}</th>
                <th>{t("upCol.plan")}</th>
                <th>{t("upCol.signal")}</th>
              </tr>
            </thead>
            <tbody>
              {b.upgradeReady.map((u) => (
                <tr key={u.workspace.id}>
                  <td>
                    <Link href={`/workspaces/${u.workspace.id}`}>{u.workspace.name}</Link>
                  </td>
                  <td>{planLabel(u.plan)}</td>
                  <td className="small">{u.signals.map((s) => s.message).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** เงินสด: ค้างรับตามอายุ (สีสถานะ) · รับล่วงหน้า · คาดการณ์ MRR 3 เดือน (แท่งประ) */
function Cash({ b }: { b: Business }) {
  const t = useTranslations("ob.biz");
  const f = useFormatter();
  const fmt = useFmt();
  const a = b.arAging;
  const overdue = a.d0_30 + a.d31_60 + a.d60plus;
  const now = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
  return (
    <section className="card stack">
      <h2 className="card-title">{t("cash")}</h2>
      <HBars
        label={t("aging", { amount: fmt.money(overdue) })}
        rows={(["d0_30", "d31_60", "d60plus"] as const).map((k) => ({ key: k, label: t(`agingRows.${k}`), value: a[k], of: Math.max(overdue, 1), display: fmt.money(a[k]), tone: k === "d0_30" ? "warn" : "bad" }))}
      />
      <span className="muted small">
        {t("aging", { amount: fmt.money(overdue) })} · {t("agingRows.notDue")} {fmt.money(a.notDue)}
      </span>
      {b.cashThisMonth && (
        <div className="field">
          <span className="field-label">{t("cashReceived", { month: monthText(f, b.cashThisMonth.month) })}</span>
          <b>{fmt.money(b.cashThisMonth.receivedSatang)}</b>
          <span className="muted small">{t("cashInvoices", { n: b.cashThisMonth.invoices })}</span>
        </div>
      )}
      <div className="field">
        <span className="field-label">{t("deferred")}</span>
        <b>{fmt.money(b.deferredRevenueSatang)}</b>
      </div>
      <div className="field">
        <span className="field-label">
          {t("forecast")} <span className="muted small">· {t("forecastSub")}</span>
        </span>
        <ColumnChart
          label={t("forecast")}
          height={120}
          cols={[
            { label: t("now", { month: monthText(f, now) }), value: b.mrrSatang, display: fmt.money(b.mrrSatang), tone: "primary", labelled: true },
            ...b.forecast.map((x, i) => ({ label: monthText(f, x.month), value: x.mrrSatang, display: fmt.money(x.mrrSatang), tone: "forecast" as const, labelled: i === b.forecast.length - 1 })),
          ]}
        />
      </div>
    </section>
  );
}

/** หน้าย่อยของเมนูวิเคราะห์ (Funnel และ Retention · การใช้ฟีเจอร์) · ใช้ข้อมูลชุดเดียวกับหน้าธุรกิจ (cache ของ ops-api) */
export function BusinessSubPage({ title, desc, children }: { title: string; desc: string; children: (b: Business) => ReactNode }) {
  const t = useTranslations("ob.biz");
  const f = useFormatter();
  const me = useMe().data;
  const read = hasAny(me, "owner", "finance", "auditor");
  const q = useQuery({ queryKey: ["ops", "business", "quarter"], queryFn: () => api.get<Business>("/business?period=quarter"), enabled: !!me && read });
  if (me && !read) return <NoAccess need={["owner", "finance", "auditor"]} />;
  return (
    <>
      <PageHead
        title={title}
        desc={
          <>
            {desc}
            {q.data && <span className="muted"> · {t("computed", { time: f.dateTime(new Date(q.data.computedAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>}
          </>
        }
        actions={
          <Link className="link-button small" href="/business">
            {t("title")}
          </Link>
        }
      />
      {q.isPending ? <LoadingState /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : children(q.data)}
    </>
  );
}

const PERIODS: Period[] = ["30d", "quarter", "12m"];

/** ส่งออกตัวเลขหลักของหน้าเป็น CSV (UTF-8 + BOM เปิดด้วย Excel ได้) · ทำในเบราว์เซอร์จากข้อมูลที่แสดงอยู่ */
function downloadCsv(b: Business, t: ReturnType<typeof useTranslations<"ob.biz">>) {
  const baht = (n: number | null | undefined) => (n == null ? "" : (n / 100).toFixed(2));
  const rows: (string | number | null)[][] = [
    [t("csv.section"), t("csv.item"), t("csv.value")],
    [t("csv.summary"), "MRR", baht(b.mrrSatang)],
    [t("csv.summary"), t("kpi.margin"), b.margin.marginPct ?? ""],
    [t("csv.summary"), t("csv.cost"), baht(b.margin.costSatang)],
    ...(b.cashThisMonth ? [[t("csv.summary"), t("cashReceived", { month: b.cashThisMonth.month }), baht(b.cashThisMonth.receivedSatang)]] : []),
    ...b.margin.byPlan.map((p) => [t("csv.byPlan"), p.plan, `${baht(p.revenueSatang)} / ${baht(p.costSatang)} / ${p.marginPct ?? ""}%`]),
    ...Object.entries(b.funnel).map(([k, v]) => [t("csv.funnel"), k, v]),
    ...b.channels.map((c) => [t("csv.channels"), c.source, `${c.signups ?? ""} / ${c.newPaying} / ${baht(c.spendSatang)} / ${baht(c.cacSatang)}`]),
    ...b.cancellationReasons.map((r) => [t("csv.reasons"), r.reason, r.n]),
  ];
  const esc = (v: unknown) => {
    const x = v == null ? "" : String(v);
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const csv = "\ufeff" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `friday-business-${b.period ?? "quarter"}-${b.computedAt.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
