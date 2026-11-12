"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Avatar, Badge, Button, ErrorState, Forbidden, LoadingState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, today, localeDateFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { inboxKey, type Filter, type InboxNotification, type InboxPage as Page } from "./types";
import styles from "./inbox.module.css";
import { statusTone } from "@/lib/status";
import { DAILY_EVENT, DailySummary, useDailyTitle } from "@/features/daily-summary/daily-summary";

const FILTERS: Filter[] = ["all", "unread", "assign", "mention", "activity", "due"];
const TONE: Record<string, "blue" | "purple" | "teal" | "amber" | "red" | "neutral"> = { assign: "blue", mention: "purple", activity: "teal", due: "amber" };
const issueHref = (ws: string, key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key.split("-")[0])}/board?issue=${encodeURIComponent(key)}`;
const bkkDate = (iso: string) => today(new Date(iso));
const timeOf = (iso: string) => localeDateFormat({ hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(iso));

export function useLabels() {
  const t = useTranslations("inbox-bell.inbox");
  // คีย์ข้อความใช้ "__" แทน "." ของชื่อ Event (next-intl ใช้ "." แยกระดับ)
  const k = (type: string) => type.replace(/\./g, "__");
  const has = (group: "types" | "verbs", type: string) => t.has(`${group}.${k(type)}` as never);
  return {
    type: (n: InboxNotification) => (has("types", n.eventType) ? t(`types.${k(n.eventType)}` as never) : t("types.other")),
    verb: (n: InboxNotification) => (has("verbs", n.eventType) ? t(`verbs.${k(n.eventType)}` as never) : t("verbs.other")),
    actor: (n: InboxNotification) => n.actor?.displayName ?? (n.payload.actorName as string | undefined) ?? t("system"),
  };
}

export function InboxPage({ ws }: { ws: string }) {
  const t = useTranslations("inbox-bell.inbox");
  const { me } = useWorkspace();
  const search = useSearchParams();
  const cache = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const urlN = search.get("n");
  const [selected, setSelected] = useState<string | null>(urlN);
  // ?n= เปลี่ยนโดยไม่ remount (คลิกกระดิ่งขณะอยู่ใน Inbox, Back/Forward) → เลือกตาม URL ใหม่
  const [seenN, setSeenN] = useState(urlN);
  /** รายการที่ URL ขอแต่ยังไม่อยู่ในหน้าที่โหลด · โหลดหน้าถัดไปจนเจอหรือหมด */
  const [target, setTarget] = useState<string | null>(urlN);
  if (urlN !== seenN) {
    setSeenN(urlN);
    setSelected(urlN);
    setTarget(urlN);
    // ตัวกรองที่เลือกอยู่อาจซ่อนรายการเป้าหมาย
    if (urlN) setFilter("all");
  }
  const labels = useLabels();
  const dailyTitle = useDailyTitle();
  const query = useInfiniteQuery({
    queryKey: [...inboxKey(ws), filter],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page>(`/me/notifications?workspace=${encodeURIComponent(ws)}&filter=${filter}&limit=50${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: inboxKey(ws) });
    await cache.invalidateQueries({ queryKey: queryKeys.notifications });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; message?: string }) => api.post(path, body ?? {}),
    onSuccess: async (_r, v) => {
      if (v.message) toast({ message: v.message });
      await refresh();
    },
    onError: (e) => toast({ message: e instanceof Error ? e.message : String(e) }),
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = query.data?.pages[0]?.counts;
  const current = items.find((n) => n.id === selected) ?? null;

  useEffect(() => {
    if (!target || !query.data || query.isFetching) return;
    if (query.data.pages.some((p) => p.items.some((n) => n.id === target)) || !query.hasNextPage) setTarget(null);
    else void query.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, query.data, query.isFetching, query.hasNextPage]);

  // เปิดรายการแล้วถือว่าอ่าน
  useEffect(() => {
    if (current && !current.readAt) act.mutate({ path: `/me/notifications/${current.id}/read` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  if (query.isPending) return <div className={styles.layout}><LoadingState /></div>;
  if (query.error) return <div className={styles.layout}>{query.error instanceof ApiError && query.error.status === 403 ? <Forbidden /> : <ErrorState error={query.error} retry={() => query.refetch()} />}</div>;

  const now = today();
  const yesterday = new Date(Date.parse(`${now}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const groups = (["today", "yesterday", "earlier"] as const).map((g) => ({ g, list: items.filter((n) => { const d = bkkDate(n.createdAt); return g === "today" ? d === now : g === "yesterday" ? d === yesterday : d < yesterday; }) })).filter((x) => x.list.length);

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <div>
            <h1>{t("title")}</h1>
            <div className={`muted ${styles.sub}`}>{t("subtitle", { name: me.displayName, count: counts?.unread ?? 0 })}</div>
          </div>
          <div className={styles.actions}>
            <Button className={styles.markAll} disabled={act.isPending || !counts?.unread} onClick={() => act.mutate({ path: "/me/notifications/read-all", body: { workspace: ws }, message: t("markedAll") })}>{t("markAll")}</Button>
            <Link className={`button button-secondary ${styles.settings}`} href={`/work/${encodeURIComponent(ws)}/profile`}>{t("settings")}</Link>
          </div>
        </div>
        <div className={styles.tabs} role="group" aria-label={t("filterLabel")}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className={styles.ftab} data-filter={f} aria-pressed={filter === f} onClick={() => { setFilter(f); setSelected(null); }}>
              {t(`filters.${f}`)}<span className={styles.count}>{counts?.[f] ?? 0}</span>
            </button>
          ))}
        </div>
      </header>
      <div className={`${styles.layout} ${current ? styles.showDetail : ""} ${groups.length ? styles.grouped : ""}`}>
        <section className={styles.list} aria-label={t("listLabel")}>
          {!items.length && <div className={styles.empty}>{t("empty")}</div>}
          {groups.map(({ g, list }) => (
            <div key={g} className={styles.group}>
              <div className={styles.gl}>{t(`groups.${g}`)}</div>
              {list.map((n) => (
                <button key={n.id} type="button" className={`${styles.nt} ${!n.readAt ? styles.unread : ""} ${n.id === selected ? styles.sel : ""}`} aria-current={n.id === selected ? "true" : undefined} onClick={() => setSelected(n.id)}>
                  <Avatar person={{ id: n.actor?.id ?? n.id, displayName: labels.actor(n), avatarUrl: n.actor?.avatarUrl ?? null }} />
                  <span className={styles.ntBody}>
                    <span style={{ fontSize: 13 }}><b>{labels.actor(n)}</b> {labels.verb(n)}</span>
                    <span className={styles.ntTitle}>{n.eventType === DAILY_EVENT ? dailyTitle(n.payload) : `${n.issue?.key ?? (n.payload.issueKey as string | undefined) ?? ""} ${n.issue?.title ?? (n.payload.title as string | undefined) ?? ""}`}</span>
                    {typeof n.payload.message === "string" && <span className={styles.quote}>“{n.payload.message}”</span>}
                    <span className={styles.meta}>{[n.project?.name ?? n.project?.key, `${formatDate(n.createdAt, me.yearFormat)} ${timeOf(n.createdAt)}`].filter(Boolean).join(" · ")}<Badge tone={TONE[n.category] ?? "neutral"}>{labels.type(n)}</Badge></span>
                  </span>
                  {!n.readAt && <span className={styles.dot} role="img" aria-label={t("unread")} />}
                </button>
              ))}
            </div>
          ))}
          {query.hasNextPage && <div className={styles.more}><Button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{t("loadMore")}</Button></div>}
        </section>
        <aside className={`${styles.card} ${styles.detail}`} aria-label={t("detailLabel")}>
          {!current ? <div className={styles.empty}>{t("selectHint")}</div> : <Detail ws={ws} n={current} busy={act.isPending} onBack={() => setSelected(null)} run={(path, message, body) => act.mutate({ path, message, body })} />}
        </aside>
      </div>
    </>
  );
}

function Detail({ ws, n, busy, onBack, run }: { ws: string; n: InboxNotification; busy: boolean; onBack: () => void; run: (path: string, message?: string, body?: unknown) => void }) {
  const t = useTranslations("inbox-bell.inbox");
  const { me } = useWorkspace();
  const labels = useLabels();
  const dailyTitle = useDailyTitle();
  const daily = n.eventType === DAILY_EVENT;
  const key = n.issue?.key ?? (n.payload.issueKey as string | undefined);
  const req = n.dueRequest;
  const year = me.yearFormat;
  // ปุ่มทำงานหลักอยู่ในส่วนหัว (ผู้ใช้ขอ 2026-11-11: แบบหน้ารายละเอียดของเว็บหางาน) · เนื้อหาอยู่ด้านล่าง
  const actions = req ? (
    req.status === "pending" && req.canDecide ? (
      <div className={styles.actions}>
        <Button className={styles.approve} disabled={busy} onClick={() => run(`/w/${encodeURIComponent(ws)}/due-requests/${req.id}/approve`, t("approvedToast"))}>{t("approve")}</Button>
        <Button className={styles.rejectBtn} disabled={busy} onClick={() => run(`/w/${encodeURIComponent(ws)}/due-requests/${req.id}/reject`, t("rejectedToast"))}>{t("reject")}</Button>
        {key && <Link className="button button-secondary" href={issueHref(ws, key)}>{t("openIssue")}</Link>}
      </div>
    ) : (
      <div className={styles.actions}>
        <Badge tone={req.status === "approved" ? "green" : req.status === "rejected" ? "red" : "neutral"}>{t(`decision.${req.status}`, { name: req.decidedBy?.displayName ?? "-" })}</Badge>
      </div>
    )
  ) : (
    <div className={styles.actions}>
      {key && <Link className="button button-primary" href={issueHref(ws, key)}>{t("openIssue")}</Link>}
      {daily && <Link className="button button-primary" href={`/work/${encodeURIComponent(ws)}/my-tasks`}>{t("openMyTasks")}</Link>}
      <Button disabled={busy} onClick={() => run(`/me/notifications/${n.id}/done`, t("acknowledged"))}>{t("acknowledge")}</Button>
      <Button disabled={busy} onClick={() => run(`/me/notifications/${n.id}/snooze`, t("snoozed"), { preset: "tomorrow" })}>{t("remindTomorrow")}</Button>
    </div>
  );
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.dHead}>
          <Button className={styles.back} size="icon" variant="ghost" aria-label={t("back")} onClick={onBack}><ArrowLeft size={18} aria-hidden /></Button>
          <Avatar size="large" person={{ id: n.actor?.id ?? n.id, displayName: labels.actor(n), avatarUrl: n.actor?.avatarUrl ?? null }} />
          <div className={styles.heroText}>
            <div className={styles.heroTitle}><b>{labels.actor(n)}</b> {labels.verb(n)}</div>
            {key && <div className={styles.heroIssue}>{key} {n.issue?.title ?? (n.payload.title as string | undefined) ?? ""}</div>}
            {daily && <div className={styles.heroIssue}>{dailyTitle(n.payload)}</div>}
            <div className="muted" style={{ fontSize: 12 }}>{[n.project?.name, `${formatDate(n.createdAt, year)} ${timeOf(n.createdAt)}`].filter(Boolean).join(" · ")}</div>
          </div>
          <Badge tone={TONE[n.category] ?? "neutral"}>{labels.type(n)}</Badge>
        </div>
        {actions}
      </div>
      <div className={styles.dBody}>
        {n.issue && !n.issue.deleted ? (
          <Link className={styles.issueCard} href={issueHref(ws, n.issue.key)}>
            <span className="muted" style={{ fontSize: 11 }}>{n.issue.key} · {n.issue.type}{n.issue.moduleName ? ` · ${n.issue.moduleName}` : ""}</span>
            <b>{n.issue.title}</b>
            <span className={styles.meta} style={{ marginTop: 8 }}>
              <span className={`badge status-pill-${statusTone(n.issue.status.category, n.issue.status.name)}`}>{n.issue.status.name}</span>
              <span>{n.issue.planEnd ? t("due", { date: formatDate(n.issue.planEnd, year) }) : t("noDue")}</span>
              {!!n.issue.assignees.length && <span>· {t("assignee", { names: n.issue.assignees.map((a) => a.displayName).join(", ") })}</span>}
            </span>
          </Link>
        ) : key ? <div className="muted">{t("issueGone")}</div> : null}
        {typeof n.payload.message === "string" && <div className={styles.quoteBox}>“{n.payload.message}”</div>}
        {daily && <DailySummary ws={ws} payload={n.payload} />}
        {req && (
          <>
            <div className={styles.diff}><span className="muted">{t("dueDiff")}</span><span className="muted" style={{ textDecoration: "line-through" }}>{formatDate(req.currentDue, year)}</span><span aria-hidden="true">→</span><b>{formatDate(req.requestedDue, year)}</b></div>
            <div className="muted" style={{ fontSize: 13 }}>{t("reasonLabel", { reason: req.reasonLabel })}{req.detail ? ` · ${req.detail}` : ""}</div>
          </>
        )}
        <div className={styles.foot}><span className="muted">{t("why")}</span> <b>{n.reason}</b></div>
      </div>
    </>
  );
}
