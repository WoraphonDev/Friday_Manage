"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { ErrorBlock, TableSkeleton } from "@/components/kit";
import { api } from "@/lib/api";
import { HBars } from "../business/_parts/charts";
import { planLabel, useFmt } from "../workspaces/_parts/format";

export interface Usage {
  days: number;
  projects: { active: number; total: number };
  issues: { created: number; closed: number };
  comments: { total: number; mentions: number };
  files: { uploaded: number; bytes: number };
  line: { total: number; sentPct: number | null };
  automation: { runs: number; workspaces: number };
  api: { calls: number; tokens: number };
  imports: { total: number; failed: number; failedPct: number | null };
  payingWorkspaces: number;
  featureAdoption: { feature: string; workspaces: number; pct: number | null }[];
}

export interface FeedItem {
  kind: "signup" | "new" | "upgrade" | "downgrade" | "cancel" | "reactivate" | "churn_payment" | "ticket" | "payment" | "staff";
  at: string;
  workspace: { id: string; name: string } | null;
  data: Record<string, string | number | boolean | null>;
}

/** การใช้งานระบบของลูกค้า 30 วัน (Main.dc.html) · รวมทุก Workspace · การใช้ฟีเจอร์คิดจากลูกค้าที่จ่าย */
export function UsageCard() {
  const t = useTranslations("ob.main.usage");
  const tb = useTranslations("ob.biz");
  const fmt = useFmt();
  const q = useQuery({ queryKey: ["ops", "overview", "usage"], queryFn: () => api.get<Usage>("/overview/usage"), staleTime: 300_000 });
  const n = fmt.num;
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  const tiles = q.data
    ? [
        { key: "projects", value: n(q.data.projects.active), note: t("projectsNote", { total: n(q.data.projects.total) }) },
        { key: "issues", value: n(q.data.issues.created), note: t("issuesNote", { closed: n(q.data.issues.closed) }) },
        { key: "comments", value: n(q.data.comments.total), note: t("commentsNote", { mentions: n(q.data.comments.mentions) }) },
        { key: "files", value: n(q.data.files.uploaded), note: fmt.bytes(q.data.files.bytes) },
        { key: "line", value: n(q.data.line.total), note: q.data.line.sentPct == null ? t("noSend") : t("lineNote", { pct: pct(q.data.line.sentPct) }) },
        { key: "automation", value: n(q.data.automation.runs), note: t("automationNote", { n: n(q.data.automation.workspaces) }) },
        { key: "api", value: n(q.data.api.calls), note: t("apiNote", { n: n(q.data.api.tokens) }) },
        { key: "imports", value: n(q.data.imports.total), note: q.data.imports.total ? t("importsNote", { n: n(q.data.imports.failed), pct: pct(q.data.imports.failedPct) }) : t("noImport") },
      ]
    : [];
  return (
    <section className="card" aria-label={t("title")}>
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("sub")}</span>
        <span className="spacer" />
        <Link className="link-button small" href="/business/adoption">
          {t("more")}
        </Link>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="usage-tiles" aria-label={t("title")}>
            {tiles.map((x) => (
              <li key={x.key} className="usage-tile">
                <span className="muted small">{t(`tile.${x.key}` as "tile.projects")}</span>
                <b className="num">{x.value}</b>
                <span className="muted small">{x.note}</span>
              </li>
            ))}
          </ul>
          <span className="muted small">{t("adoptionSub", { n: n(q.data.payingWorkspaces) })}</span>
          {!q.data.featureAdoption.length ? (
            <p className="muted small">{tb("featuresEmpty")}</p>
          ) : (
            <HBars
              label={t("adoption")}
              rows={q.data.featureAdoption.map((x) => ({
                key: x.feature,
                label: tb.has(`featureLabels.${x.feature}` as "featureLabels.table") ? tb(`featureLabels.${x.feature}` as "featureLabels.table") : x.feature,
                value: x.pct ?? 0,
                of: 100,
                display: pct(x.pct),
                tone: "primary",
              }))}
            />
          )}
        </>
      )}
    </section>
  );
}

const TAG: Record<FeedItem["kind"], string> = {
  signup: "pill inf",
  new: "pill ok",
  upgrade: "pill inf",
  downgrade: "pill warn",
  cancel: "pill bad",
  churn_payment: "pill bad",
  reactivate: "pill ok",
  ticket: "pill warn",
  payment: "pill ok",
  staff: "pill",
};

/** กิจกรรมล่าสุด (Main.dc.html) · ไม่มีจำนวนเงิน · ชำระเงิน / การกระทำของพนักงานแสดงตามสิทธิ์ที่ ops-api ตัดมาแล้ว */
export function FeedCard() {
  const t = useTranslations("ob.main.feed");
  const tb = useTranslations("ob.biz");
  const f = useFormatter();
  const q = useQuery({ queryKey: ["ops", "overview", "feed"], queryFn: () => api.get<{ items: FeedItem[] }>("/overview/feed"), staleTime: 60_000, refetchInterval: 120_000 });
  const when = (iso: string) => {
    const d = new Date(iso);
    const day = (x: Date) => new Date(x.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const today = day(new Date());
    if (day(d) === today) return f.dateTime(d, { timeStyle: "short" });
    if (day(new Date(Date.now() - 86_400_000)) === day(d)) return t("yesterday");
    return f.dateTime(d, { day: "numeric", month: "short" });
  };
  const text = (x: FeedItem) => {
    const ws = x.workspace?.name ?? t("unknownWs");
    const d = x.data;
    switch (x.kind) {
      case "signup":
        return d.trial ? t("text.trial", { ws, plan: planLabel(d.plan as string | null), n: Number(d.members ?? 0) }) : t("text.signup", { ws });
      case "new":
        return t("text.new", { ws, plan: planLabel(d.to as string | null) });
      case "upgrade":
      case "downgrade":
        return t(`text.${x.kind}`, { ws, from: planLabel(d.from as string | null), to: planLabel(d.to as string | null) });
      case "cancel":
        return d.reason ? t("text.cancelReason", { ws, reason: tb.has(`reasonLabels.${d.reason}` as "reasonLabels.other") ? tb(`reasonLabels.${d.reason}` as "reasonLabels.other") : String(d.reason) }) : t("text.cancel", { ws });
      case "churn_payment":
        return t("text.churnPayment", { ws });
      case "reactivate":
        return t("text.reactivate", { ws });
      case "ticket":
        return t(d.assignee ? "text.ticketAssigned" : "text.ticket", { ws, subject: String(d.subject ?? ""), assignee: String(d.assignee ?? "") });
      case "payment":
        return d.invoice ? t("text.paymentInvoice", { ws, invoice: String(d.invoice) }) : t("text.payment", { ws });
      case "staff":
        return t("text.staff", { staff: String(d.staff ?? t("system")), what: String(d.reason || d.action) });
    }
  };
  return (
    <section className="card" aria-label={t("title")}>
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={5} cols={3} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <p className="muted small">{t("empty")}</p>
      ) : (
        <ul className="feed">
          {q.data.items.map((x, i) => (
            <li key={`${x.kind}-${x.at}-${i}`}>
              <span className={`${TAG[x.kind]} feed-tag`}>{t(`tag.${x.kind}` as "tag.signup")}</span>
              <span className="feed-text">
                {x.workspace && x.kind !== "staff" ? <Link href={`/workspaces/${x.workspace.id}`}>{text(x)}</Link> : text(x)}
              </span>
              <time className="muted num small" dateTime={x.at}>
                {when(x.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
