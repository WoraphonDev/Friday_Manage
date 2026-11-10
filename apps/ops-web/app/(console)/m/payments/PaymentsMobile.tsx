"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { hasAny, rolesOf } from "@/components/access";
import { ErrorBlock, NoAccess, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { MobileHead } from "../_parts/MobileFrame";

type Reason = "amount_mismatch" | "wht_not_declared" | "duplicate_slip" | "payer_name_mismatch" | "unmatched" | "double_payment" | "wht_certificate" | "unreadable_slip";
interface Item {
  id: string;
  reason: Reason;
  suggestion: string | null;
  expectedSatang: number;
  receivedSatang: number;
  hasSlip: boolean;
  waitingSince: string;
  minutesLeft: number;
  nearSla: boolean;
  workspace: { id: string; name: string; slug: string };
  invoice: { id: string; number: string };
  actions: { yes: "confirm" | "credit" | null; no: "reject" | null };
}
interface Queue {
  items: Item[];
  stats: { autoPct: number | null; confirmedToday: number; nearSla: number };
  slaHours: number;
}
type Check = { tone: "ok" | "warn" | "bad"; text: string };
const KEY = ["ops", "m", "payments"] as const;
const REASON_TONE: Record<Reason, "bad" | "warn" | "inf"> = { duplicate_slip: "bad", unreadable_slip: "bad", double_payment: "inf", amount_mismatch: "warn", wht_not_declared: "warn", payer_name_mismatch: "warn", unmatched: "warn", wht_certificate: "inf" };

/** M6.3 · คิวชำระผิดปกติ: การ์ดบอกสิ่งที่ระบบแนะนำ · ตัดสินจาก bottom sheet โดยไม่ออกจากรายการ */
export function PaymentsMobile() {
  const t = useTranslations("mob.payments");
  const tr = useTranslations("money.reasons");
  const f = useFormatter();
  const toast = useToast();
  const me = useMe().data;
  const read = hasAny(me, "finance", "owner");
  const decide = hasAny(me, "finance");
  const params = useSearchParams();
  const router = useRouter();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<Queue>("/m/payments"), enabled: read, refetchInterval: 60_000 });
  const cur = q.data?.items.find((x) => x.id === params?.get("id")) ?? null;
  const show = (id: string | null) => router.replace(id ? `/m/payments?id=${id}` : "/m/payments");
  const money = (satang: number) => f.number(satang / 100, { style: "currency", currency: "THB", maximumFractionDigits: 0 });
  const dur = (min: number) => (Math.abs(min) >= 60 ? t("hours", { n: Math.round(Math.abs(min) / 60) }) : t("minutes", { n: Math.abs(min) }));
  const wait = (x: Item) =>
    x.minutesLeft <= 0 ? { tone: "bad" as const, text: t("over") } : x.nearSla ? { tone: "bad" as const, text: t("left", { time: dur(x.minutesLeft) }) } : { tone: null, text: t("waiting", { time: dur(Math.round((Date.now() - new Date(x.waitingSince).getTime()) / 60_000)) }) };
  const checks = (x: Item): Check[] => {
    const diff = x.receivedSatang - x.expectedSatang;
    const pct = x.expectedSatang ? Math.round((Math.abs(diff) / x.expectedSatang) * 1000) / 10 : 0;
    const list: Check[] = [diff === 0 ? { tone: "ok", text: t("check.amountOk") } : { tone: "warn", text: diff < 0 ? t("check.amountShort", { pct }) : t("check.amountOver", { pct }) }];
    list.push(x.hasSlip ? { tone: "ok", text: t("check.slip") } : { tone: "warn", text: t("check.noSlip") });
    const bad = x.reason === "duplicate_slip" || x.reason === "unreadable_slip";
    list.push({ tone: bad ? "bad" : x.reason === "double_payment" ? "ok" : "warn", text: t(`check.${x.reason}`) });
    return list;
  };
  const act = useMutation({
    mutationFn: async ({ x, yes }: { x: Item; yes: boolean }) => {
      const action = yes ? x.actions.yes : x.actions.no;
      if (action === "confirm") await api.post(`/payments/${x.id}/confirm`, { note: t("note") });
      else if (action === "credit") await api.post(`/payments/${x.id}/to-credit`, { reason: t("creditReason") });
      else if (action === "reject") await api.post(`/payments/${x.id}/reject`, { reason: t(`rejectReason.${x.reason as "duplicate_slip"}`) });
      return { x, label: yesLabel(x, yes) };
    },
    onSuccess: ({ x, label }) => (toast(t("done", { ws: x.workspace.name, action: label })), show(null), void cache.invalidateQueries({ queryKey: ["ops"] })),
  });
  const yesLabel = (x: Item, yes: boolean) => (yes ? (x.reason === "duplicate_slip" ? t("yesDuplicate") : x.actions.yes ? t(`yes.${x.actions.yes}`) : "") : x.reason === "wht_not_declared" ? t("noWht") : t("no"));

  if (me && !read) return <NoAccess need={["finance", "owner"]} mine={rolesOf(me)} />;
  return (
    <>
      <MobileHead title={t("title")} sub={q.data ? t("count", { n: q.data.items.length }) : undefined} />
      {q.isPending ? (
        <TableSkeleton rows={4} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          <div className="m-stats">
            <div className="m-stat">
              <span className="muted small">{t("autoToday")}</span>
              <b className="num">{q.data.stats.autoPct == null ? "—" : `${q.data.stats.autoPct}%`}</b>
            </div>
            <div className={q.data.stats.nearSla ? "m-stat m-stat-bad" : "m-stat"}>
              <span className="muted small">{t("nearSla")}</span>
              <b className="num">{q.data.stats.nearSla}</b>
            </div>
          </div>
          {!decide && <Notice tone="info" title={t("viewOnly")} />}
          {!q.data.items.length ? (
            <section className="m-done">
              <span className="m-done-icon" aria-hidden="true">
                ✓
              </span>
              <p>{t("empty")}</p>
            </section>
          ) : (
            <ul className="m-list" aria-label={t("title")}>
              {q.data.items.map((x) => {
                const w = wait(x);
                return (
                  <li key={x.id}>
                    <button type="button" className="m-card m-card-btn" onClick={() => show(x.id)}>
                      <span className="row">
                        <Pill tone={REASON_TONE[x.reason]}>{tr(x.reason)}</Pill>
                        {w.tone ? <Pill tone={w.tone}>{w.text}</Pill> : <span className="muted small">{w.text}</span>}
                      </span>
                      <b>{x.workspace.name}</b>
                      {x.suggestion && <span className="small">{t("hint", { text: x.suggestion })}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {cur && (
        <div className="m-sheet-wrap" onClick={(e) => e.target === e.currentTarget && show(null)}>
          <section className="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-pay-title">
            <span className="row">
              <Pill tone={REASON_TONE[cur.reason]}>{tr(cur.reason)}</Pill>
              <span className="muted small">{cur.invoice.number}</span>
            </span>
            <h2 id="m-pay-title" className="m-title">
              {cur.workspace.name}
            </h2>
            <p className="muted small">{t("expected", { amount: money(cur.expectedSatang), received: money(cur.receivedSatang) })}</p>
            {cur.suggestion && (
              <div className="m-advice">
                <span className="small muted">{t("advice")}</span>
                <span>{cur.suggestion}</span>
              </div>
            )}
            <ul className="m-rows">
              {checks(cur).map((c) => (
                <li key={c.text}>
                  <span>{c.text}</span>
                  <Pill tone={c.tone}>{t(`tag.${c.tone}`)}</Pill>
                </li>
              ))}
            </ul>
            <InlineError error={act.error} />
            {decide && (cur.actions.yes || cur.actions.no) && (
              <div className="m-actions">
                {cur.actions.no && (
                  <Button className="m-btn" disabled={act.isPending} onClick={() => act.mutate({ x: cur, yes: false })}>
                    {yesLabel(cur, false)}
                  </Button>
                )}
                {cur.actions.yes && (
                  <Button variant="primary" className="m-btn" disabled={act.isPending} onClick={() => act.mutate({ x: cur, yes: true })}>
                    {yesLabel(cur, true)}
                  </Button>
                )}
              </div>
            )}
            {(!cur.actions.yes || !cur.actions.no) && (
              <>
                <p className="muted small">{t("desktopWhy")}</p>
                <Link className="button m-btn" href="/payments?tab=verify">
                  {t("desktop")}
                </Link>
              </>
            )}
            <Button variant="ghost" className="m-btn" onClick={() => show(null)}>
              {t("close")}
            </Button>
          </section>
        </div>
      )}
    </>
  );
}
