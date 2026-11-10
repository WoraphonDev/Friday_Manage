"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { kindText, reauthenticate } from "@/components/dialogs";
import { ErrorBlock, NoAccess, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/query";
import { MobileHead } from "../_parts/MobileFrame";

type Summary = { kind: "money"; satang: number } | { kind: "discount"; percent: number; months: number | null } | { kind: "days"; days: number } | null;
interface Item {
  id: string;
  kind: string;
  requestedBy: string;
  requesterName: string;
  reason: string;
  rule: string | null;
  summary: Summary;
  createdAt: string;
  expiresAt: string;
  canSelfApprove: boolean;
  workspace: { id: string; name: string; createdAt: string; plan: string | null; paidInvoices: number; refunds: number } | null;
}
interface Decided {
  id: string;
  kind: string;
  status: "approved" | "rejected";
  workspace: string | null;
  summary: Summary;
}
const KEY = ["ops", "m", "approvals"] as const;

/** M6.1 · อนุมัติบนมือถือ: รายการ → รายละเอียด → ยืนยันด้วย Passkey ทุกครั้ง → ผล */
export function ApprovalsMobile() {
  const t = useTranslations("mob.approvals");
  const tc = useTranslations("common");
  const f = useFormatter();
  const me = useMe().data;
  const owner = hasAny(me, "owner");
  const params = useSearchParams();
  const router = useRouter();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<{ items: Item[]; decidedToday: Decided[] }>("/m/approvals"), enabled: owner, refetchInterval: 60_000 });
  const [key, setKey] = useState(false);
  const [done, setDone] = useState<{ text: string } | null>(null);
  const sel = params?.get("id") ?? null;
  const cur = q.data?.items.find((x) => x.id === sel) ?? null;
  const open = (id: string | null) => (setDone(null), setKey(false), router.replace(id ? `/m/approvals?id=${id}` : "/m/approvals"));
  const amount = (s: Summary) =>
    !s ? "—" : s.kind === "money" ? f.number(s.satang / 100, { style: "currency", currency: "THB", maximumFractionDigits: 0 }) : s.kind === "discount" ? (s.months == null ? t("discountOpen", { percent: s.percent }) : t("discount", { percent: s.percent, months: s.months })) : t("days", { days: s.days });
  const decide = useMutation({
    mutationFn: async ({ item, approve }: { item: Item; approve: boolean }) => {
      if (approve) {
        // อนุมัติบนมือถือยืนยันด้วย Passkey ทุกครั้ง แม้เพิ่งยืนยันไปไม่ถึง 15 นาที
        await reauthenticate();
        await api.post(`/approvals/${item.id}/approve`, {});
      } else await api.post(`/approvals/${item.id}/reject`, {});
      return { item, approve };
    },
    onSuccess: ({ item, approve }) => {
      const vars = { type: kindText(tc, item.kind), ws: item.workspace?.name ?? "" };
      setKey(false);
      setDone({ text: approve ? t("doneApproved", vars) : t("doneRejected", vars) });
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });

  if (me && !owner) return <NoAccess need={["owner"]} mine={rolesOf(me)} />;
  if (done)
    return (
      <section className="m-done" aria-live="polite">
        <span className="m-done-icon" aria-hidden="true">
          ✓
        </span>
        <h1 className="m-title">{done.text}</h1>
        <p className="muted">{t("doneNote")}</p>
        <Button className="m-btn" onClick={() => open(null)}>
          {t("back")}
        </Button>
      </section>
    );
  if (cur) {
    const self = cur.requestedBy === me?.id;
    const blocked = self && !cur.canSelfApprove;
    const ws = cur.workspace;
    return (
      <>
        <MobileHead title={`${kindText(tc, cur.kind)} ${ws?.name ?? ""}`.trim()} back={{ label: t("back"), onClick: () => open(null) }} />
        <section className="m-card">
          <dl className="m-dl">
            <dt>{t("amount")}</dt>
            <dd>
              <span className="m-amount">{amount(cur.summary)}</span>
              <span className="muted small m-block">
                {t("by", { name: cur.requesterName, ago: f.relativeTime(new Date(cur.createdAt)) })} · {t("expires", { ago: f.relativeTime(new Date(cur.expiresAt)) })}
              </span>
            </dd>
            <dt>{t("reason")}</dt>
            <dd>{cur.reason}</dd>
            {cur.rule && (
              <>
                <dt>{t("rule")}</dt>
                <dd>{cur.rule}</dd>
              </>
            )}
            <dt>{t("customer")}</dt>
            <dd>{ws ? t("fact", { date: f.dateTime(new Date(ws.createdAt), { dateStyle: "medium" }), paid: ws.paidInvoices, refunds: ws.refunds }) : t("noCustomer")}</dd>
          </dl>
        </section>
        {blocked ? <Notice tone="warn" title={t("selfOnly")} /> : self && <Notice tone="info" title={t("selfAllowed")} />}
        <InlineError error={decide.error instanceof ApiError || !(decide.error instanceof Error) ? decide.error : new Error(t("keyCancelled"))} />
        {!blocked && (
          <div className="m-actions">
            {!self && (
              <Button className="m-btn" onClick={() => decide.mutate({ item: cur, approve: false })} disabled={decide.isPending}>
                {t("reject")}
              </Button>
            )}
            <Button variant="primary" className="m-btn" onClick={() => setKey(true)} disabled={decide.isPending}>
              {t("approve")}
            </Button>
          </div>
        )}
        {key && (
          <div className="m-sheet-wrap">
            <section className="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-key-title">
              <span className="m-key-icon" aria-hidden="true">
                <KeyRound size={28} />
              </span>
              <h2 id="m-key-title" className="m-title">
                {t("keyTitle")}
              </h2>
              <p className="muted small">{t("keyDesc")}</p>
              <Button variant="primary" className="m-btn" onClick={() => decide.mutate({ item: cur, approve: true })} disabled={decide.isPending}>
                {decide.isPending ? t("keyWaiting") : t("keyStart")}
              </Button>
              <Button className="m-btn" onClick={() => setKey(false)} disabled={decide.isPending}>
                {t("cancel")}
              </Button>
            </section>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <MobileHead title={t("title")} sub={q.data ? t("count", { n: q.data.items.length }) : undefined} />
      {q.isPending ? (
        <TableSkeleton rows={3} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.items.length ? (
            <section className="m-done">
              <span className="m-done-icon" aria-hidden="true">
                ✓
              </span>
              <p>{t("empty")}</p>
            </section>
          ) : (
            <ul className="m-list" aria-label={t("title")}>
              {q.data.items.map((x) => (
                <li key={x.id}>
                  <button type="button" className="m-card m-card-btn" onClick={() => open(x.id)}>
                    <span className="row">
                      <Pill tone={x.kind === "billing.refund" ? "bad" : "inf"}>{kindText(tc, x.kind)}</Pill>
                      <b>{x.workspace?.name ?? t("noCustomer")}</b>
                    </span>
                    <span className="m-amount">{amount(x.summary)}</span>
                    <span className="muted small">{t("by", { name: x.requesterName, ago: f.relativeTime(new Date(x.createdAt)) })}</span>
                    {x.rule && <span className="small m-rule">{x.rule}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.data.decidedToday.length > 0 && (
            <section className="m-card">
              <h2 className="card-title">{t("today")}</h2>
              <ul className="m-rows">
                {q.data.decidedToday.map((d) => (
                  <li key={d.id}>
                    <span>
                      {kindText(tc, d.kind)} {d.workspace ?? ""} {d.summary ? amount(d.summary) : ""}
                    </span>
                    <Pill tone={d.status === "approved" ? "ok" : "bad"}>{t(d.status)}</Pill>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
