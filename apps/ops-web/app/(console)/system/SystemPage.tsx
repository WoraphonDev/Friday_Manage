"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ErrorBlock, Notice, PageHead } from "@/components/kit";
import { buttonClass, LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../workspaces/_parts/format";

interface Status {
  versions: { web: string | null; api: string | null; ops: string | null };
  api: {
    probes: number;
    uptimePct: number | null;
    avgMs: number | null;
    p95Ms: number | null;
    last: { ok: boolean; ms: number; at: number } | null;
    hours: { from: string; probes: number; up: number; avgMs: number | null }[];
    errorRate: number | null;
  };
  database: { ok: boolean; ms: number };
  queue:
    | { configured: false }
    | {
        configured: true;
        waiting: number;
        active: number;
        delayed: number;
        failed: number;
        completed: number;
      };
  deliveries: {
    channel: string;
    total: number;
    sent: number;
    failed: number;
    pending: number;
  }[];
  heavyWorkspaces: {
    id: string;
    slug: string;
    name: string;
    apiCalls: number;
    webhookCalls: number;
    automationRuns: number;
    storageBytes: number;
    activeUsers: number;
  }[];
  incidents: {
    id: string;
    title: string;
    status: string;
    impact: string;
    startedAt: string;
    internal: boolean;
  }[];
}

/** หน้า 7 · สถานะระบบ (System.dc.html) ไม่รวมส่วน Feature flags (เฟส 3) · วิศวกร / Owner */
export function SystemPage() {
  const t = useTranslations("ss.system");
  const to = useTranslations("ss.ops");
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ["ops", "system"],
    queryFn: () => api.get<Status>("/system/status"),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const down = d.api.last && !d.api.last.ok;
  const ms = (n: number | null) => (n == null ? "—" : t("ms", { n }));
  return (
    <>
      <PageHead
        title={t("title")}
        desc={`${t("desc")} · ${t("versions")} ${t("versionValue", { web: d.versions.web ?? t("unknown"), api: d.versions.api ?? t("unknown") })}`}
        actions={
          <Link className={buttonClass("primary")} href="/incidents?new=1">
            {t("report")}
          </Link>
        }
      />
      {down ? <Notice tone="bad" title={t("down")} /> : d.api.probes > 0 && <Notice tone="ok" title={t("ok")} />}
      <div className="grid-3">
        <section className="card">
          <span className="muted small">{t("uptime")}</span>
          <span className="page-title">{d.api.uptimePct == null ? "—" : `${d.api.uptimePct}%`}</span>
          <span className="muted small">{d.api.probes ? `${d.api.probes} checks` : t("noProbe")}</span>
        </section>
        <section className="card">
          <span className="muted small">
            {t("avg")} · {t("p95")}
          </span>
          <span className="page-title">{ms(d.api.avgMs)}</span>
          <span className="muted small">
            {t("p95")} {ms(d.api.p95Ms)} · {t("db")} {ms(d.database.ms)}
          </span>
        </section>
        <section className="card">
          <span className="muted small">{t("errorRate")}</span>
          <span className="page-title">{d.api.errorRate == null ? "—" : `${d.api.errorRate}%`}</span>
          <span className="muted small">{d.api.errorRate == null ? t("notConnected") : ""}</span>
        </section>
      </div>
      <section className="card">
        <h2 className="card-title">{t("hours")}</h2>
        <div
          role="img"
          aria-label={t("hours")}
          style={{
            display: "flex",
            gap: 3,
            alignItems: "flex-end",
            height: 48,
          }}
        >
          {d.api.hours.map((h) => {
            const pct = h.probes ? h.up / h.probes : null;
            return (
              <span
                key={h.from}
                title={`${fmt.dateTime(h.from)} · ${h.up}/${h.probes}`}
                style={{
                  flex: 1,
                  height: "100%",
                  borderRadius: 3,
                  background: pct == null ? "var(--subtle)" : pct === 1 ? "var(--status-done-dot)" : pct > 0.9 ? "var(--status-progress-dot)" : "var(--status-overdue-dot)",
                }}
              />
            );
          })}
        </div>
      </section>
      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t("queue")}</h2>
            <span className="card-sub">{t("queueSub")}</span>
          </div>
          {d.queue.configured ? (
            <>
              <table className="tbl">
                <tbody>
                  {(["waiting", "active", "delayed", "failed"] as const).map((k) => (
                    <tr key={k}>
                      <td>{t(k)}</td>
                      <td className="num">{d.queue.configured ? d.queue[k] : 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Link className={buttonClass("ghost", "small")} href="/incidents#jobs">
                {t("openFailed")}
              </Link>
            </>
          ) : (
            <p className="muted small">{t("queueOff")}</p>
          )}
        </section>
        <section className="card">
          <h2 className="card-title">{t("deliveries")}</h2>
          {!d.deliveries.length ? (
            <p className="muted small">{t("noDeliveries")}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("channel")}</th>
                  <th className="num">{t("sent")}</th>
                  <th className="num">{t("failedN")}</th>
                  <th className="num">{t("pending")}</th>
                </tr>
              </thead>
              <tbody>
                {d.deliveries.map((x) => (
                  <tr key={x.channel}>
                    <td>{x.channel}</td>
                    <td className="num">{x.sent}</td>
                    <td className="num">{x.failed ? <span className="pill bad">{x.failed}</span> : 0}</td>
                    <td className="num">{x.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("heavy")}</h2>
          <span className="card-sub">{t("heavyNote")}</span>
        </div>
        {!d.heavyWorkspaces.length ? (
          <p className="muted small">{t("noHeavy")}</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th className="num">{t("apiCalls")}</th>
                  <th className="num">{t("automation")}</th>
                  <th className="num">{t("webhook")}</th>
                  <th className="num">{t("storage")}</th>
                  <th className="num">{t("users")}</th>
                </tr>
              </thead>
              <tbody>
                {d.heavyWorkspaces.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <Link href={`/workspaces/${w.id}`}>{w.name}</Link> <span className="muted mono small">{w.id.slice(0, 8)}</span>
                    </td>
                    <td className="num">{fmt.num(w.apiCalls)}</td>
                    <td className="num">{fmt.num(w.automationRuns)}</td>
                    <td className="num">{fmt.num(w.webhookCalls)}</td>
                    <td className="num">{fmt.bytes(w.storageBytes)}</td>
                    <td className="num">{w.activeUsers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2 className="card-title">{t("incidents")}</h2>
        {!d.incidents.length ? (
          <p className="muted small">{t("noIncidents")}</p>
        ) : (
          d.incidents.map((i) => (
            <div key={i.id} className="row small">
              <span className={i.status === "resolved" ? "pill ok" : "pill bad"}>{to(`state.${i.status}` as "state.resolved")}</span>
              <span>{i.title}</span>
              <span className="muted">· {fmt.dateTime(i.startedAt)}</span>
              {i.internal && <span className="pill">{to("internal")}</span>}
            </div>
          ))
        )}
      </section>
    </>
  );
}
