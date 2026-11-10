"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Chip, Empty, ErrorBlock, NoAccess, PageHead, TableSkeleton } from "@/components/kit";
import { Button, errorToast, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../workspaces/_parts/format";
import { AttachDialog, MessageDialog } from "./_parts/Dialogs";
import { Suppressions } from "./_parts/Suppressions";
import { type Channel, type Detail, type Item, type ListResponse, STATUS_TONE, useEventText } from "./_parts/types";

export const DLV_KEY = ["ops", "deliveries"] as const;
const CHANNEL_TONE: Record<Channel, "inf" | "ok" | "neu"> = { email: "inf", line: "ok", line_group: "ok", webhook: "neu" };

/** ประวัติการส่งแจ้งเตือน (Canvas › Deliveries · เฟส 2 · O23) */
export function DeliveriesPage() {
  const t = useTranslations("dlv");
  const fmt = useFmt();
  const me = useMe().data;
  const params = useSearchParams();
  const read = hasAny(me, "owner", "support", "engineer");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<"all" | "email" | "line" | "webhook">("all");
  const [status, setStatus] = useState<"all" | "ok" | "fail" | "quiet" | "blocked">("all");
  const [picked, setPicked] = useState<string | null>(params?.get("id") ?? null);
  const q = useDeferredValue(query.trim());
  const qs = (before?: string | null) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (channel !== "all") p.set("channel", channel);
    if (status !== "all") p.set("status", status);
    if (before) p.set("before", before);
    return p.toString();
  };
  const list = useInfiniteQuery({
    queryKey: [...DLV_KEY, "list", q, channel, status],
    queryFn: ({ pageParam }) => api.get<ListResponse>(`/deliveries?${qs(pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: !!me && read,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const stats = list.data?.pages[0]?.stats;
  const current = picked ?? items[0]?.id ?? null;
  const eventText = useEventText();
  if (me && !read) return <NoAccess need={["owner", "support", "engineer"]} mine={rolesOf(me)} />;
  const filtered = !!q || channel !== "all" || status !== "all";
  const pct = (n: number | null | undefined) => (!stats ? "…" : n == null ? t("stats.none") : `${n}%`);
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      <section className="stats" aria-label={t("stats.label")}>
        <Stat label={t("stats.total")} value={stats ? fmt.num(stats.total) : "…"} note={stats ? t("stats.totalNote", { email: fmt.num(stats.byChannel.email), line: fmt.num(stats.byChannel.line), webhook: fmt.num(stats.byChannel.webhook) }) : ""} />
        <Stat label={t("stats.delivered")} value={pct(stats?.deliveredPct)} tone="ok" />
        <Stat label={t("stats.failed")} value={stats ? fmt.num(stats.failed.total) : "…"} tone="bad" note={stats ? t("stats.failedNote", { webhook: stats.failed.webhook, email: stats.failed.email, line: stats.failed.line }) : ""} />
        <Stat label={t("stats.quiet")} value={stats ? fmt.num(stats.waitingQuiet) : "…"} tone="warn" note={t("stats.quietNote")} />
        <Stat label={t("stats.bounce")} value={pct(stats?.bouncePct)} note={stats?.bouncePct != null && stats.bouncePct >= 2 ? t("stats.bounceHigh") : t("stats.bounceNote")} />
      </section>
      <section className="card">
        <div className="row">
          <div style={{ flex: "1 1 260px", maxWidth: 380 }}>
            <Input type="search" aria-label={t("search")} placeholder={t("searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="row" role="group" aria-label={t("channels")}>
            {(["all", "email", "line", "webhook"] as const).map((c) => (
              <Chip key={c} pressed={channel === c} onClick={() => setChannel(c)}>
                {t(`channel.${c}`)}
              </Chip>
            ))}
          </div>
          <label className="row small muted push-end">
            {t("statusLabel")}
            <select className="input" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {(["all", "ok", "fail", "quiet", "blocked"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`statusFilter.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="split">
          <div className="split-main">
            {list.isPending ? (
              <TableSkeleton rows={6} cols={6} />
            ) : list.error ? (
              <ErrorBlock error={list.error} retry={() => void list.refetch()} />
            ) : !items.length ? (
              <Empty title={filtered ? t("empty") : t("emptyAll")} onClearFilters={filtered ? () => (setQuery(""), setChannel("all"), setStatus("all")) : undefined} />
            ) : (
              <>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">{t("col.time")}</th>
                        <th scope="col">{t("col.channel")}</th>
                        <th scope="col">{t("col.to")}</th>
                        <th scope="col">{t("col.event")}</th>
                        <th scope="col">{t("col.status")}</th>
                        <th scope="col" className="num">
                          {t("col.attempts")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r) => (
                        <Row key={r.id} r={r} on={r.id === current} onPick={() => setPicked(r.id)} event={eventText(r.event)} />
                      ))}
                    </tbody>
                  </table>
                </div>
                {list.hasNextPage && (
                  <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
                    <Button size="small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                      {t("more")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
          <DetailPanel id={current} />
        </div>
      </section>
      <Suppressions />
    </>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "ok" | "bad" | "warn" }) {
  return (
    <div className={tone ? `stat stat-${tone}` : "stat"}>
      <span className="muted small">{label}</span>
      <b className="num">{value}</b>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

function Row({ r, on, onPick, event }: { r: Item; on: boolean; onPick: () => void; event: string }) {
  const t = useTranslations("dlv");
  const f = useFmt();
  return (
    <tr className={on ? "row-on" : undefined} onClick={onPick} aria-selected={on}>
      <td className="num muted">
        <button type="button" className="link-button" aria-label={`${f.dateTime(r.createdAt)} · ${r.to}`} onClick={(e) => (e.stopPropagation(), onPick())}>
          {f.dateTime(r.createdAt)}
        </button>
      </td>
      <td>
        <Pill tone={CHANNEL_TONE[r.channel]}>{t(`channel.${r.channel}`)}</Pill>
      </td>
      <td>
        <div className="cell-main">{r.to}</div>
        <div className="cell-sub">{r.workspace.name}</div>
      </td>
      <td>{event}</td>
      <td>
        <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
      </td>
      <td className="num muted">{r.attempts}</td>
    </tr>
  );
}

/** แผงขวา: ลำดับเหตุการณ์ คำตอบจากปลายทาง และปุ่มส่งซ้ำ / ดูข้อความ / แนบใน Ticket */
function DetailPanel({ id }: { id: string | null }) {
  const t = useTranslations("dlv.detail");
  const tr = useTranslations("dlv");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const eventText = useEventText();
  const [viewing, setViewing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const q = useQuery({ queryKey: [...DLV_KEY, "detail", id], queryFn: () => api.get<Detail>(`/deliveries/${id}`), enabled: !!id });
  const resend = useMutation({
    mutationFn: () => api.post(`/deliveries/${id}/resend`, {}),
    onSuccess: () => (toast(t("resent")), void cache.invalidateQueries({ queryKey: DLV_KEY })),
    onError: (e) => toast(errorToast(e)),
  });
  const d = q.data;
  return (
    <aside className="split-side" aria-label={t("label")}>
      {!id ? (
        <p className="muted small">{t("pick")}</p>
      ) : q.isPending ? (
        <TableSkeleton rows={4} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        d && (
          <>
            <div className="row">
              <h2 className="card-title">{t("heading", { channel: tr(`channel.${d.channel}`), status: tr(`status.${d.status}`), ws: d.workspace?.name ?? "" })}</h2>
              <Pill tone={STATUS_TONE[d.status]} className="push-end">
                {t("attempts", { status: tr(`status.${d.status}`), attempts: d.attempts })}
              </Pill>
            </div>
            <div className="muted small">{t("target", { to: d.to, event: eventText(d.event) })}</div>
            <ol className="timeline" aria-label={t("label")}>
              {d.log.map((e, i) => (
                <li key={i} className={`timeline-item tone-${e.kind === "attempt_ok" ? "ok" : e.kind === "attempt_failed" || e.kind === "bounced" || e.kind === "complained" ? "bad" : e.kind === "paused" || e.kind === "quiet" ? "warn" : "inf"}`}>
                  <span className="muted small num">{fmt.dateTime(e.at)}</span>
                  <span className="small">{logText(t, e)}</span>
                </li>
              ))}
            </ol>
            <div className="code-box">
              <div className="muted small">{t("response")}</div>
              <code className="mono small">{d.response ? `HTTP ${d.response.status ?? "—"} ${d.response.body ?? ""}`.trim() : t("noResponse")}</code>
            </div>
            {d.webhook?.status === "paused" && <div className="notice notice-warn small">{`${d.response?.status === 404 ? `${t("gone404")} · ` : ""}${t("paused")}`}</div>}
            {d.suppression && <div className="notice notice-warn small">{t("suppressed", { reason: tr(`suppressions.reason.${d.suppression.reason}` as "suppressions.reason.manual"), date: fmt.date(d.suppression.since) })}</div>}
            {d.resendRequested && <div className="muted small">{t("resendPending")}</div>}
            <div className="row">
              {d.canResend && (
                <Button size="small" disabled={resend.isPending} onClick={() => resend.mutate()}>
                  {t("resend")}
                </Button>
              )}
              <Button size="small" onClick={() => setViewing(true)}>
                {t("view")}
              </Button>
              {hasAny(me, "owner", "support") && (
                <Button size="small" onClick={() => setAttaching(true)}>
                  {t("attach")}
                </Button>
              )}
            </div>
            {viewing && <MessageDialog d={d} onClose={() => setViewing(false)} onAttach={hasAny(me, "owner", "support") ? () => (setViewing(false), setAttaching(true)) : undefined} />}
            {attaching && <AttachDialog id={d.id} onClose={() => setAttaching(false)} />}
          </>
        )
      )}
    </aside>
  );
}

function logText(t: ReturnType<typeof useTranslations<"dlv.detail">>, e: Detail["log"][number]) {
  switch (e.kind) {
    case "attempt_ok":
      return t("log.attempt_ok", { attempt: e.attempt ?? 1, status: e.status ? ` · HTTP ${e.status}` : "" });
    case "attempt_failed":
      return t("log.attempt_failed", { attempt: e.attempt ?? 1, status: e.status ? ` · HTTP ${e.status}` : "", message: e.message ?? "" }) + (e.final ? t("log.giveUp") : t("log.retryNext"));
    case "quiet":
    case "paused":
    case "complained":
      return t(`log.${e.kind}`);
    case "suppressed":
    case "cancelled":
    case "resend":
    case "bounced":
      return t(`log.${e.kind}`, { message: e.message ?? "" });
    default:
      return e.kind;
  }
}
