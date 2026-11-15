"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, Check, CheckCheck, ChevronRight, MoreVertical, Settings } from "lucide-react";
import { ActionSheet, Avatar, Badge, Button, Dialog, ErrorState, Forbidden, LoadingState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { MobileHeader } from "@/components/shell/mobile-header";
import { useIsMobile } from "@/lib/use-mobile";
import { exitDelay, useSlidingIndicator } from "@/lib/motion";
import { api, ApiError } from "@/lib/api";
import { formatDate, today, localeDateFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { inboxKey, type Filter, type InboxNotification, type InboxPage as Page } from "./types";
import styles from "./inbox.module.css";
import { statusTone } from "@/lib/status";
import { DAILY_EVENT, DailySummary, useDailyTitle } from "@/features/daily-summary/daily-summary";

const FILTERS: Filter[] = ["all", "unread", "assign", "mention", "activity", "due"];
/** มือถือตามต้นแบบ: ยังไม่อ่าน · ทั้งหมด · ถึงฉัน · มอบหมาย (ตัวกรองอื่นอยู่บน desktop) */
const MOBILE_FILTERS: Filter[] = ["unread", "all", "mention", "assign"];
/** พื้นที่เลื่อนของ .m-chips ตรงกับ .m-chip ที่เลือกใน globals.css (ม่วงอ่อน ขอบม่วง มุม 22) */
const CHIP_PILL = { "--ind-bg": "var(--primary-soft)", "--ind-border": "1px solid var(--primary-border)", "--ind-radius": "22px" } as CSSProperties;
const TONE: Record<string, "blue" | "purple" | "teal" | "amber" | "red" | "neutral"> = { assign: "blue", mention: "purple", activity: "teal", due: "amber" };
const issueHref = (ws: string, key: string) => `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key.split("-")[0])}/board?issue=${encodeURIComponent(key)}`;
const bkkDate = (iso: string) => today(new Date(iso));
const timeOf = (iso: string) => localeDateFormat({ hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(new Date(iso));

/** หัวข้อของรายการ: เลขงาน + ชื่องาน · แจ้งเตือนระดับโปรเจกต์ (เช่น พักโปรเจกต์) ไม่มีงาน จึงใช้ชื่อโปรเจกต์ */
function itemTitle(n: InboxNotification) {
  const issue = `${n.issue?.key ?? (n.payload.issueKey as string | undefined) ?? ""} ${n.issue?.title ?? (n.payload.title as string | undefined) ?? ""}`.trim();
  return issue || (n.project?.name ?? n.project?.key ?? "");
}

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
  const mobile = useIsMobile();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // แท็บกรอง: desktop เส้นใต้เลื่อนตามแท็บ · มือถือพื้นม่วงอ่อนเลื่อนตามชิป (หน้าตาเดียวกับ .m-chip ที่เลือก)
  const tabsRef = useSlidingIndicator<HTMLDivElement>(`.${styles.ftab}`);
  const chipsRef = useSlidingIndicator<HTMLDivElement>(".m-chip");
  const urlN = search.get("n");
  const [selected, setSelected] = useState<string | null>(urlN);
  /**
   * รายการที่เพิ่งเปิดอ่านในแท็บนี้ · แท็บ "ยังไม่อ่าน" โหลดใหม่หลังทำเครื่องหมายอ่านแล้วจะไม่มีรายการนั้น
   * รายละเอียดด้านขวาจึงหายทันที (ผู้ใช้แจ้ง 2026-11-12) → แสดงต่อเป็น "อ่านแล้ว" จนกว่าจะเปลี่ยนแท็บหรือจัดการรายการนั้น
   */
  const [kept, setKept] = useState<InboxNotification[]>([]);
  /**
   * รับทราบ / เตือนพรุ่งนี้บน desktop: การ์ดยุบออกจากรายการก่อน (ค้างไว้จนจบ animation แม้ API ตัดออกไปแล้ว)
   * แล้วเปิดรายการถัดไปเมื่อรายการเดิมหายจากข้อมูลจริง (advance) · ผู้ใช้เลือกจากตัวอย่าง 2026-11-15
   */
  const [leaving, setLeaving] = useState<{ n: InboxNotification; action: "done" | "snooze"; height: number } | null>(null);
  const advance = useRef<{ from: string; next: string | null } | null>(null);
  const changeFilter = (next: Filter) => { setFilter(next); setSelected(null); setKept([]); };
  // ?n= เปลี่ยนโดยไม่ remount (คลิกกระดิ่งขณะอยู่ใน Inbox, Back/Forward) → เลือกตาม URL ใหม่
  const [seenN, setSeenN] = useState(urlN);
  /** รายการที่ URL ขอแต่ยังไม่อยู่ในหน้าที่โหลด · โหลดหน้าถัดไปจนเจอหรือหมด */
  const [target, setTarget] = useState<string | null>(urlN);
  if (urlN !== seenN) {
    setSeenN(urlN);
    setSelected(urlN);
    setTarget(urlN);
    // ตัวกรองที่เลือกอยู่อาจซ่อนรายการเป้าหมาย
    if (urlN) { setFilter("all"); setKept([]); }
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
    onError: (e) => {
      // ทำไม่สำเร็จ รายการยังอยู่ · ไม่ต้องเลื่อนไปรายการถัดไปทีหลัง
      advance.current = null;
      toast({ message: e instanceof Error ? e.message : String(e) });
    },
  });
  const loaded = query.data?.pages.flatMap((p) => p.items) ?? [];
  const ghost = leaving && !loaded.some((n) => n.id === leaving.n.id) && !kept.some((k) => k.id === leaving.n.id) ? [leaving.n] : [];
  const missing = [...kept.filter((k) => !loaded.some((n) => n.id === k.id)), ...ghost];
  const items = missing.length ? [...loaded, ...missing].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : loaded;
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
    if (current && !current.readAt) {
      const read = { ...current, readAt: new Date().toISOString() };
      setKept((list) => [...list.filter((n) => n.id !== read.id), read]);
      act.mutate({ path: `/me/notifications/${current.id}/read` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // รายการที่รับทราบหายจากข้อมูลแล้ว (และการ์ดยุบจบแล้ว) → เปิดรายการถัดไปที่ยังอยู่
  useEffect(() => {
    const step = advance.current;
    if (!step || leaving || items.some((n) => n.id === step.from)) return;
    advance.current = null;
    if (selected === step.from) setSelected(step.next && items.some((n) => n.id === step.next) ? step.next : null);
  });

  if (query.isPending) return <div className={styles.layout}><LoadingState /></div>;
  if (query.error) return <div className={styles.layout}>{query.error instanceof ApiError && query.error.status === 403 ? <Forbidden /> : <ErrorState error={query.error} retry={() => query.refetch()} />}</div>;

  const now = today();
  const yesterday = new Date(Date.parse(`${now}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const groups = (["today", "yesterday", "earlier"] as const).map((g) => ({ g, list: items.filter((n) => { const d = bkkDate(n.createdAt); return g === "today" ? d === now : g === "yesterday" ? d === yesterday : d < yesterday; }) })).filter((x) => x.list.length);

  const run = (path: string, message?: string, body?: unknown) => {
    // รับทราบ / เตือนพรุ่งนี้ / ตัดสินคำขอ = จัดการแล้ว ให้หลุดจากแท็บตามผลจริงของ API
    if (current) setKept((list) => list.filter((n) => n.id !== current.id));
    act.mutate({ path, message, body });
  };
  const settle = (action: "done" | "snooze", path: string, message: string, body?: unknown) => {
    if (current && !mobile) {
      const order = groups.flatMap((g) => g.list);
      const at = order.findIndex((n) => n.id === current.id);
      advance.current = { from: current.id, next: (order[at + 1] ?? order[at - 1])?.id ?? null };
      const ms = exitDelay();
      if (ms) {
        const card = document.querySelector<HTMLElement>(`[data-nt="${current.id}"]`);
        setLeaving({ n: current, action, height: card?.offsetHeight ?? 80 });
        // การ์ดเริ่มยุบหลังปุ่มขึ้น ✓ (200ms ตาม .out ใน CSS)
        setTimeout(() => setLeaving(null), ms + 200);
      }
    }
    run(path, message, body);
  };

  if (mobile) {
    // W29 · มือถือแบบต้นแบบ (ฐาน A): หัวใหญ่ + ⋮ · ชิปมีตัวเลข · กลุ่มวันในกล่องขอบมน
    // แตะแถวเปิดรายละเอียดใน popup (Dialog เดิม) แทนการแทนที่ทั้งหน้า · รายการยังอยู่ ปิดแล้วตำแหน่งเลื่อนและตัวกรองคงเดิม
    return (
      <div className="m-page">
        <MobileHeader
          title={t("mobileTitle")}
          subtitle={t("mobileSubtitle", { count: counts?.unread ?? 0 })}
          bell={false}
          actions={<button type="button" className="m-icon" aria-label={t("moreActions")} aria-haspopup="dialog" onClick={() => setMenu(true)}><MoreVertical size={20} aria-hidden="true" /></button>}
        />
        <div ref={chipsRef} className="m-chips motion-pill" style={CHIP_PILL} role="group" aria-label={t("filterLabel")}>
          {MOBILE_FILTERS.map((f) => (
            <button key={f} type="button" className="m-chip" aria-pressed={filter === f} onClick={() => changeFilter(f)}>
              {t(`filters.${f}`)} <small>{counts?.[f] ?? 0}</small>
            </button>
          ))}
        </div>
        {!items.length && <div className="m-empty" style={{ marginTop: 8 }}>{t("empty")}</div>}
        {groups.map(({ g, list }) => (
          <section key={g} aria-label={t(`groups.${g}`)}>
            <div className="m-sec">{t(`groups.${g}`)}</div>
            <div className="m-grp">
              {list.map((n) => (
                <button key={n.id} type="button" className={`m-row${!n.readAt ? " m-row-unread" : ""}`} onClick={() => setSelected(n.id)}>
                  <span className={`m-dot${n.readAt ? " m-dot-off" : ""}`} role={n.readAt ? undefined : "img"} aria-label={n.readAt ? undefined : t("unread")} />
                  <Avatar size="small" person={{ id: n.actor?.id ?? n.id, displayName: labels.actor(n), avatarUrl: n.actor?.avatarUrl ?? null }} />
                  <span className="m-row-main">
                    <b>{labels.actor(n)} {labels.verb(n)}</b>
                    <small>{n.eventType === DAILY_EVENT ? dailyTitle(n.payload) : typeof n.payload.message === "string" ? `“${n.payload.message}”` : itemTitle(n)}</small>
                  </span>
                  <span className="m-row-meta">
                    {n.category === "due" && <Badge tone="amber">{labels.type(n)}</Badge>}
                    <span>{g === "today" ? timeOf(n.createdAt) : formatDate(n.createdAt, me.yearFormat)}</span>
                  </span>
                  <ChevronRight className="m-row-chev" size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ))}
        {query.hasNextPage && <div className={styles.more}><Button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{t("loadMore")}</Button></div>}
        <Dialog open={!!current} onOpenChange={(open) => { if (!open) setSelected(null); }} title={t("detailLabel")} size="medium">
          {current && (
            <div className={styles.popup} data-testid="inbox-popup">
              <Detail key={current.id} ws={ws} n={current} busy={act.isPending} acted={leaving?.n.id === current.id ? leaving.action : undefined} run={run} settle={settle} />
            </div>
          )}
        </Dialog>
        <ActionSheet
          open={menu}
          onOpenChange={setMenu}
          title={t("mobileTitle")}
          actions={[
            { key: "read-all", label: t("markAll"), icon: <CheckCheck size={20} aria-hidden="true" />, disabled: act.isPending || !counts?.unread, onSelect: () => act.mutate({ path: "/me/notifications/read-all", body: { workspace: ws }, message: t("markedAll") }) },
            { key: "settings", label: t("settings"), icon: <Settings size={20} aria-hidden="true" />, onSelect: () => router.push(`/work/${encodeURIComponent(ws)}/profile`) },
          ]}
        />
      </div>
    );
  }

  return (
    // หน้า Inbox สูงพอดีจอ: หัว แท็บ และรายละเอียดอยู่กับที่ เลื่อนเฉพาะรายการแจ้งเตือน
    <div className={styles.page}>
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
        <div ref={tabsRef} className={`${styles.tabs} motion-underline`} role="group" aria-label={t("filterLabel")}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className={styles.ftab} data-filter={f} aria-pressed={filter === f} onClick={() => changeFilter(f)}>
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
                <button key={n.id} type="button" data-nt={n.id} className={`${styles.nt} motion-item ${!n.readAt ? styles.unread : ""} ${n.id === selected ? styles.sel : ""} ${leaving?.n.id === n.id ? styles.out : ""}`} style={leaving?.n.id === n.id ? ({ "--h": `${leaving.height}px` } as CSSProperties) : undefined} aria-current={n.id === selected ? "true" : undefined} onClick={() => setSelected(n.id)}>
                  <Avatar person={{ id: n.actor?.id ?? n.id, displayName: labels.actor(n), avatarUrl: n.actor?.avatarUrl ?? null }} />
                  <span className={styles.ntBody}>
                    <span style={{ fontSize: 13 }}><b>{labels.actor(n)}</b> {labels.verb(n)}</span>
                    <span className={styles.ntTitle}>{n.eventType === DAILY_EVENT ? dailyTitle(n.payload) : itemTitle(n)}</span>
                    {typeof n.payload.message === "string" && <span className={styles.quote}>“{n.payload.message}”</span>}
                    <span className={styles.meta}>{[n.project?.name ?? n.project?.key, `${formatDate(n.createdAt, me.yearFormat)} ${timeOf(n.createdAt)}`].filter(Boolean).join(" · ")}<Badge tone={TONE[n.category] ?? "neutral"}>{labels.type(n)}</Badge></span>
                  </span>
                  {/* อ่านแล้วจุดหดหายแทนการถอดออกทันที (คงไว้ใน DOM แบบซ่อนจากโปรแกรมอ่านหน้าจอ) */}
                  <span className={`${styles.dot} ${n.readAt ? styles.dotGone : ""}`} {...(n.readAt ? { "aria-hidden": true } : { role: "img", "aria-label": t("unread") })} />
                </button>
              ))}
            </div>
          ))}
          {query.hasNextPage && <div className={styles.more}><Button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{t("loadMore")}</Button></div>}
        </section>
        <aside className={`${styles.card} ${styles.detail}`} aria-label={t("detailLabel")}>
          {!current ? <div className={styles.empty}>{t("selectHint")}</div> : <Detail key={current.id} ws={ws} n={current} busy={act.isPending} acted={leaving?.n.id === current.id ? leaving.action : undefined} onBack={() => setSelected(null)} run={run} settle={settle} />}
        </aside>
      </div>
    </div>
  );
}

function Detail({ ws, n, busy, acted, onBack, run, settle }: {
  ws: string; n: InboxNotification; busy: boolean;
  /** ไม่ส่งมา = อยู่ใน popup มือถือ ซึ่งมีปุ่มปิดของ Dialog แล้ว */
  onBack?: () => void;
  /** ปุ่มที่เพิ่งกด (รับทราบ / เตือนพรุ่งนี้) ระหว่างการ์ดยุบ · ขึ้น ✓ และกดซ้ำไม่ได้ */
  acted?: "done" | "snooze";
  run: (path: string, message?: string, body?: unknown) => void;
  settle: (action: "done" | "snooze", path: string, message: string, body?: unknown) => void;
}) {
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
      <Button className={acted === "done" ? styles.acted : undefined} disabled={busy || !!acted} onClick={() => settle("done", `/me/notifications/${n.id}/done`, t("acknowledged"))}>{acted === "done" && <Check className={styles.actedIcon} size={14} aria-hidden="true" />}{t("acknowledge")}</Button>
      <Button className={acted === "snooze" ? styles.acted : undefined} disabled={busy || !!acted} onClick={() => settle("snooze", `/me/notifications/${n.id}/snooze`, t("snoozed"), { preset: "tomorrow" })}>{acted === "snooze" && <Check className={styles.actedIcon} size={14} aria-hidden="true" />}{t("remindTomorrow")}</Button>
    </div>
  );
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.dHead}>
          {onBack && <Button className={styles.back} size="icon" variant="ghost" aria-label={t("back")} onClick={onBack}><ArrowLeft size={18} aria-hidden /></Button>}
          <span className={styles.heroAvatar}><Avatar size="large" person={{ id: n.actor?.id ?? n.id, displayName: labels.actor(n), avatarUrl: n.actor?.avatarUrl ?? null }} /></span>
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
            <div className={`muted ${styles.reason}`}>{t("reasonLabel", { reason: req.reasonLabel })}{req.detail ? ` · ${req.detail}` : ""}</div>
          </>
        )}
        <div className={styles.foot}><span className="muted">{t("why")}</span> <b>{n.reason}</b></div>
      </div>
    </>
  );
}
