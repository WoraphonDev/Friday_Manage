"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bell as BellIcon } from "lucide-react";
import { Avatar, ErrorState, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { List, Me, NotificationSummary, Workspace } from "@/lib/types";
import styles from "./bell.module.css";
import { DAILY_EVENT, useDailyTitle } from "@/features/daily-summary/daily-title";

type Tab = "all" | "unread" | "mention";
interface BellItem {
  id: string;
  workspaceId: string;
  eventType: string;
  actor: { id: string; displayName: string | null } | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
const POLL_MS = 60_000;
/** API ส่งชื่องานเป็น issueTitle (event อื่นบางชนิดใช้ title) */
const titleOf = (n: BellItem) => (typeof n.payload.issueTitle === "string" ? n.payload.issueTitle : typeof n.payload.title === "string" ? n.payload.title : null);

/**
 * เชื่อม Realtime (A17) เพื่อรู้ว่ามีแจ้งเตือนใหม่ · เชื่อมไม่ได้ = ให้ผู้เรียก poll แทน
 * `notification` = มีรายการใหม่ (แสดง Toast) · `unread` = จำนวนเปลี่ยนจากการอ่าน/เสร็จ/เลื่อน ในอีก session (ไม่แสดง Toast)
 */
export function useNotificationSocket(userId: string | undefined, onNotification: (unread: number) => void, onUnreadChanged?: () => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onNotification);
  handler.current = onNotification;
  const changed = useRef(onUnreadChanged);
  changed.current = onUnreadChanged;
  useEffect(() => {
    if (!userId || typeof window === "undefined" || typeof WebSocket === "undefined" || process.env.NODE_ENV === "test") return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = (attempt: number) => {
      ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/v1/realtime`);
      ws.onopen = () => { setConnected(true); ws?.send(JSON.stringify({ op: "subscribe", channel: `user:${userId}` })); };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { type?: string; unread?: { total?: number } };
          if (m.type === "notification") handler.current(m.unread?.total ?? 0);
          else if (m.type === "unread") changed.current?.();
        } catch { /* ข้อความที่ไม่ใช่ JSON ไม่สนใจ */ }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(() => open(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
      };
    };
    open(0);
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, [userId]);
  return connected;
}

export function Bell({ workspace, unread = 0 }: { workspace: string; unread?: number }) {
  const t = useTranslations("common.nav");
  const tb = useTranslations("inbox-bell.bell");
  const cache = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const me = useQuery({ queryKey: queryKeys.me, queryFn: () => api.get<Me>("/me") });
  const ti = useTranslations("inbox-bell.inbox");
  const dailyTitle = useDailyTitle();
  // สรุปประจำวันเก็บหัวเรื่องเป็นภาษาไทย · สร้างใหม่ตามภาษาผู้ใช้
  const title = (n: BellItem) => (n.eventType === DAILY_EVENT ? dailyTitle(n.payload) : titleOf(n));
  const refresh = () =>
    Promise.all([cache.invalidateQueries({ queryKey: queryKeys.notifications }), cache.invalidateQueries({ queryKey: ["bell"] }), cache.invalidateQueries({ queryKey: ["inbox"] })]);
  const live = useNotificationSocket(
    me.data?.id,
    (count) => {
      void refresh();
      void showLatest(count);
    },
    // อ่าน / เสร็จ / เลื่อนเตือนจากอีก session: อัปเดตตัวเลขโดยไม่แสดง Toast
    () => void refresh(),
  );
  // K4: Toast บอกว่าใครทำอะไร พร้อมปุ่มไปงาน / Inbox · ดึงรายการล่าสุดไม่ได้ = ใช้ข้อความนับจำนวนแบบเดิม
  async function showLatest(count: number) {
    try {
      const latest = (await api.get<{ items: BellItem[] }>("/me/notifications?filter=unread&limit=1")).items[0];
      if (!latest) throw new Error("empty");
      const slug = slugOf(latest.workspaceId) ?? workspace;
      const who = latest.actor?.displayName ?? (latest.payload.actorName as string | undefined) ?? "Friday";
      const key = typeof latest.payload.issueKey === "string" ? latest.payload.issueKey : null;
      const typeKey = latest.eventType.replace(/\./g, "__");
      const verb = ti.has(`verbs.${typeKey}` as never) ? ti(`verbs.${typeKey}` as never) : ti("verbs.other");
      const inbox = `/work/${encodeURIComponent(slug)}/inbox?n=${latest.id}`;
      toast({
        actor: { id: latest.actor?.id ?? latest.id, displayName: who },
        message: [verb, key, title(latest)].filter(Boolean).join(" "),
        meta: tb("toastMeta", { count }),
        duration: 8000,
        actions: latest.eventType === "due_request.created"
          ? [{ label: tb("toastReview"), href: inbox, primary: true }]
          : key
            ? [{ label: tb("toastOpenIssue"), href: `/work/${encodeURIComponent(slug)}/p/${encodeURIComponent(key.replace(/-\d+$/, ""))}?issue=${encodeURIComponent(key)}`, primary: true }, { label: tb("toastLater"), href: inbox }]
            : [{ label: tb("toastOpen"), href: inbox, primary: true }],
      });
    } catch {
      toast({ message: tb("toastNew", { count }) });
    }
  }
  // ไม่มี Realtime: poll ตัวนับทุก 60 วินาที (ใช้ cache ร่วมกับ shell)
  const summary = useQuery({ queryKey: queryKeys.notifications, queryFn: () => api.get<NotificationSummary>("/me/notifications/summary"), refetchInterval: live ? false : POLL_MS });
  const list = useQuery({
    queryKey: ["bell", tab],
    queryFn: () => api.get<{ items: BellItem[] }>(`/me/notifications?filter=${tab}&limit=8`),
    enabled: open,
  });
  // summary มีเฉพาะ Workspace ที่ยังมีรายการไม่อ่าน · รายการที่อ่านแล้วต้องหา slug จากรายชื่อ Workspace ทั้งหมดของผู้ใช้ (ใช้ cache ร่วมกับ shell)
  const workspaces = useQuery({ queryKey: queryKeys.workspaces, queryFn: () => api.get<List<Workspace>>("/me/workspaces"), enabled: open });
  const slugOf = (id: string) => workspaces.data?.items.find((w) => w.id === id)?.slug ?? summary.data?.workspaces.find((w) => w.id === id)?.slug;
  const inboxHref = `/work/${encodeURIComponent(workspace)}/inbox`;
  // ไม่รู้ Workspace เจ้าของรายการ: เปิด Inbox ปัจจุบันโดยไม่เลือกรายการ แทนการเดาว่าเป็นทีมที่เปิดอยู่
  const itemHref = (n: BellItem) => {
    const slug = slugOf(n.workspaceId);
    return slug ? `/work/${encodeURIComponent(slug)}/inbox?n=${encodeURIComponent(n.id)}` : inboxHref;
  };

  const readAll = useMutation({
    mutationFn: () => api.post("/me/notifications/read-all", {}),
    onSuccess: () => refresh(),
    onError: (e) => toast({ message: e instanceof Error ? e.message : String(e) }),
  });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <a
          className="button button-ghost button-icon notification-button"
          href={inboxHref}
          aria-label={t("notifications", { count: unread })}
          aria-haspopup="dialog"
          onClick={(e) => {
            // คลิกธรรมดาเปิดแผง · กดค้าง Ctrl/⌘ หรือคลิกกลางยังเปิด Inbox ได้ตามปกติ
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            setOpen((o) => !o);
          }}
        >
          <BellIcon size={20} />
          {unread > 0 && <span className="notification-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
        </a>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.pop} align="end" sideOffset={8} role="dialog" aria-label={tb("title")}>
          <div className={styles.top}>
            <b>{tb("title")}</b>
            <button type="button" className={styles.link} disabled={readAll.isPending} onClick={() => readAll.mutate()}>{tb("readAll")}</button>
            <Link href={`/work/${encodeURIComponent(workspace)}/profile`} style={{ fontSize: 12 }} onClick={() => setOpen(false)}>{tb("settings")}</Link>
          </div>
          <div className={styles.tabs} role="tablist">
            {(["all", "unread", "mention"] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={styles.tab} onClick={() => setTab(k)}>{tb(`tabs.${k}`)}</button>)}
          </div>
          <div className={styles.list}>
            {list.isPending && <div className={styles.empty}>…</div>}
            {list.isError && <ErrorState error={list.error} retry={() => void list.refetch()} />}
            {list.data && !list.data.items.length && <div className={styles.empty}>{tb("empty")}</div>}
            {list.data?.items.map((n) => {
              const who = n.actor?.displayName ?? (n.payload.actorName as string | undefined) ?? "Friday";
              const target = [n.payload.issueKey, title(n)].filter(Boolean).join(" ");
              return (
                <Link key={n.id} className={`${styles.item} ${!n.readAt ? styles.unread : ""}`} href={itemHref(n)} onClick={() => setOpen(false)}>
                  <Avatar size="small" person={{ id: n.actor?.id ?? n.id, displayName: who }} />
                  <span className={styles.text}><span><b>{who}</b> {target}</span><span className={styles.meta}>{typeof n.payload.message === "string" ? `“${n.payload.message}” · ` : ""}{formatDate(n.createdAt)}</span></span>
                  {!n.readAt && <span className={styles.dot} />}
                </Link>
              );
            })}
          </div>
          <Link className={styles.all} href={inboxHref} onClick={() => setOpen(false)}>{tb("openInbox")}</Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
