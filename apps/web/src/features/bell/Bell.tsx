"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Bell as BellIcon } from "lucide-react";
import { Avatar, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Me, NotificationSummary } from "@/lib/types";
import styles from "./bell.module.css";

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

/** เชื่อม Realtime (A17) เพื่อรู้ว่ามีแจ้งเตือนใหม่ · เชื่อมไม่ได้ = ให้ผู้เรียก poll แทน */
export function useNotificationSocket(userId: string | undefined, onNotification: (unread: number) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onNotification);
  handler.current = onNotification;
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
  const live = useNotificationSocket(me.data?.id, (count) => {
    void cache.invalidateQueries({ queryKey: queryKeys.notifications });
    void cache.invalidateQueries({ queryKey: ["bell"] });
    void cache.invalidateQueries({ queryKey: ["inbox"] });
    void showLatest(count);
  });
  // K4: Toast บอกว่าใครทำอะไร พร้อมปุ่มไปงาน / Inbox · ดึงรายการล่าสุดไม่ได้ = ใช้ข้อความนับจำนวนแบบเดิม
  async function showLatest(count: number) {
    try {
      const latest = (await api.get<{ items: BellItem[] }>("/me/notifications?filter=unread&limit=1")).items[0];
      if (!latest) throw new Error("empty");
      const slug = slugOf(latest.workspaceId);
      const who = latest.actor?.displayName ?? (latest.payload.actorName as string | undefined) ?? "Friday";
      const key = typeof latest.payload.issueKey === "string" ? latest.payload.issueKey : null;
      const typeKey = latest.eventType.replace(/\./g, "__");
      const verb = ti.has(`verbs.${typeKey}` as never) ? ti(`verbs.${typeKey}` as never) : ti("verbs.other");
      const inbox = `/work/${encodeURIComponent(slug)}/inbox?n=${latest.id}`;
      toast({
        actor: { id: latest.actor?.id ?? latest.id, displayName: who },
        message: [verb, key, titleOf(latest)].filter(Boolean).join(" "),
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
  const slugOf = (id: string) => summary.data?.workspaces.find((w) => w.id === id)?.slug ?? workspace;
  const inboxHref = `/work/${encodeURIComponent(workspace)}/inbox`;

  async function readAll() {
    await api.post("/me/notifications/read-all", {});
    await Promise.all([cache.invalidateQueries({ queryKey: queryKeys.notifications }), cache.invalidateQueries({ queryKey: ["bell"] }), cache.invalidateQueries({ queryKey: ["inbox"] })]);
  }

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
            <button type="button" className={styles.link} onClick={() => void readAll()}>{tb("readAll")}</button>
            <Link href={`/work/${encodeURIComponent(workspace)}/profile`} style={{ fontSize: 12 }} onClick={() => setOpen(false)}>{tb("settings")}</Link>
          </div>
          <div className={styles.tabs} role="tablist">
            {(["all", "unread", "mention"] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={styles.tab} onClick={() => setTab(k)}>{tb(`tabs.${k}`)}</button>)}
          </div>
          <div className={styles.list}>
            {list.isPending && <div className={styles.empty}>…</div>}
            {list.data && !list.data.items.length && <div className={styles.empty}>{tb("empty")}</div>}
            {list.data?.items.map((n) => {
              const who = n.actor?.displayName ?? (n.payload.actorName as string | undefined) ?? "Friday";
              const target = [n.payload.issueKey, titleOf(n)].filter(Boolean).join(" ");
              return (
                <Link key={n.id} className={`${styles.item} ${!n.readAt ? styles.unread : ""}`} href={`/work/${encodeURIComponent(slugOf(n.workspaceId))}/inbox?n=${n.id}`} onClick={() => setOpen(false)}>
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
