"use client";

import { type ReactNode, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeft, Gift, Sparkles } from "lucide-react";
import { Button, buttonVariants, YearFormatContext } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ctaHref, listPath, type Role, useLocalized, type WhatsNewItem, type WhatsNewList, whatsNewKey } from "./api";
import styles from "./whats-new.module.css";

const KIND_TONE = { new: styles.kindNew, improved: styles.kindImproved, fixed: styles.kindFixed } as const;

/** รายการ + จุดเหลือง · Guest ไม่เรียก API · Workspace ที่ถูกระงับได้ hidden จาก API */
function useWhatsNew(ws: string, role: Role) {
  return useQuery({
    queryKey: whatsNewKey(ws),
    queryFn: () => api.get<WhatsNewList>(listPath(ws)),
    enabled: role !== "guest",
    retry: false,
    staleTime: 300_000,
  });
}

/**
 * เปิดแผง = เห็นแล้ว: จำรายการตอนเปิดไว้แสดง "ใหม่" ระหว่างที่แผงเปิด แล้วบอก API (จุดเหลืองหาย · นับยอดเห็น)
 * "อ่านทั้งหมดแล้ว" = ทำให้ทุกรายการในแผงเป็นที่เห็นแล้วทันที
 */
function usePanel(ws: string, role: Role) {
  const cache = useQueryClient();
  const q = useWhatsNew(ws, role);
  const [snapshot, setSnapshot] = useState<WhatsNewItem[] | null>(null);
  const seen = useMutation({
    mutationFn: () => api.post(`/me/whats-new/seen`, { workspace: ws }),
    onSuccess: () => cache.setQueryData<WhatsNewList>(whatsNewKey(ws), (d) => (d ? { ...d, unseen: 0, items: d.items.map((i) => ({ ...i, unseen: false })) } : d)),
  });
  return {
    q,
    items: snapshot ?? q.data?.items ?? [],
    open() {
      setSnapshot(q.data?.items ?? null);
      if (q.data?.unseen) seen.mutate();
    },
    close: () => setSnapshot(null),
    markAll: () => setSnapshot((s) => (s ?? q.data?.items ?? []).map((i) => ({ ...i, unseen: false }))),
  };
}

function Panel({ ws, items, query, onNavigate, onMarkAll, header }: { ws: string; items: WhatsNewItem[]; query: ReturnType<typeof useWhatsNew>; onNavigate: () => void; onMarkAll: () => void; header?: ReactNode }) {
  const t = useTranslations("whats-new");
  const year = useContext(YearFormatContext);
  const local = useLocalized();
  const unseen = items.filter((i) => i.unseen).length;
  const click = (id: string) => void api.post(`/me/whats-new/${id}/click`).catch(() => undefined);
  return (
    <>
      {header ?? (
        <div className={styles.head}>
          <b className={styles.title}>{t("title")}</b>
          {unseen > 0 && <span className={styles.newPill}>{t("newCount", { count: unseen })}</span>}
          {items.length > 0 && (
            <button type="button" className={styles.link} onClick={onMarkAll}>
              {t("markAll")}
            </button>
          )}
        </div>
      )}
      <div className={styles.list}>
        {query.isPending && <div className={styles.state}>…</div>}
        {query.isError && (
          <div className={styles.state} role="alert">
            <span>{t("error")}</span>
            <Button size="small" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          </div>
        )}
        {query.data && !items.length && <div className={styles.state}>{t("empty")}</div>}
        {items.map((item) => {
          const x = local(item);
          return (
            <article key={item.id} className={cn(styles.item, !item.unseen && styles.read)} aria-label={x.title}>
              <div className={styles.meta}>
                <span className={cn(styles.kind, KIND_TONE[item.kind])}>{t(`kind.${item.kind}`)}</span>
                <span className={styles.date}>{formatDate(item.date, year, true)}</span>
              </div>
              {item.media &&
                (item.media.kind === "video" ? (
                  <video className={styles.media} src={item.media.url} controls muted playsInline aria-label={item.media.alt} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- รูปจากที่เก็บไฟล์สาธารณะที่ API ให้ ไม่ผ่าน next/image (W24)
                  <img className={styles.media} src={item.media.url} alt={item.media.alt} loading="lazy" />
                ))}
              <b className={styles.itemTitle}>{x.title}</b>
              <span className={styles.summary}>{x.summary}</span>
              {x.cta && (
                <div>
                  <Link
                    className={buttonVariants({ size: "small" })}
                    href={ctaHref(ws, x.cta.path)}
                    onClick={() => {
                      click(item.id);
                      onNavigate();
                    }}
                  >
                    {x.cta.label}
                  </Link>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {/* ลิงก์หน้าสาธารณะ fridaymanage.com/changelog ซ่อนไว้จนกว่าจะมีหน้า (คำตัดสิน W24 · งานต่อจาก W19) */}
      {items.length > 0 && <div className={styles.foot}>{t("older")}</div>}
    </>
  );
}

/** ปุ่มของขวัญบนแถบบน (ซ้ายของ "?" และกระดิ่ง) · Popover 400 px (U1) */
export function WhatsNewButton({ ws, role }: { ws: string; role: Role }) {
  const t = useTranslations("whats-new");
  const p = usePanel(ws, role);
  const [open, setOpen] = useState(false);
  // โหลดไม่สำเร็จยังแสดงปุ่ม (ไม่มีจุด) ให้เปิดแผงแล้วกดลองใหม่ได้ · ไม่บังงาน
  if (role === "guest" || p.q.data?.hidden || (!p.q.data && !p.q.isError)) return null;
  const unseen = (p.q.data?.unseen ?? 0) > 0;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) p.open();
        else p.close();
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={cn("button button-ghost button-icon", styles.trigger)} aria-label={unseen ? t("buttonUnseen") : t("button")}>
          <Gift size={20} />
          {unseen && <span className={styles.dot} data-testid="whats-new-dot" aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.pop} align="end" sideOffset={8} role="dialog" aria-label={t("title")}>
          <Panel ws={ws} items={p.items} query={p.q} onNavigate={() => setOpen(false)} onMarkAll={p.markAll} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * หน้าเต็มจอบนมือถือเปิดจากเมนู ☰ แต่เมนูปิดตัวเองเมื่อกด จึงเก็บสถานะ "เปิดอยู่" นอก component
 * แล้วให้ WhatsNewFullScreen (วางนอกเมนูใน EngagementPrompts) เป็นผู้แสดง
 */
const fullScreen = {
  open: false,
  listeners: new Set<() => void>(),
  set(v: boolean) {
    this.open = v;
    this.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    fullScreen.listeners.add(l);
    return () => void fullScreen.listeners.delete(l);
  },
};
const useFullScreen = () => useSyncExternalStore(fullScreen.subscribe, () => fullScreen.open, () => false);

/** มือถือ: แถบบนไม่มีที่วางไอคอน จึงอยู่ในเมนู ☰ (U1 · 390) */
export function WhatsNewMenuItem({ ws, role, onOpen }: { ws: string; role: Role; onOpen?: () => void }) {
  const t = useTranslations("whats-new");
  const q = useWhatsNew(ws, role);
  if (role === "guest" || q.data?.hidden || (!q.data && !q.isError)) return null;
  return (
    <button
      type="button"
      className={cn("nav-link", styles.menuItem)}
      onClick={() => {
        onOpen?.();
        fullScreen.set(true);
      }}
    >
      <Sparkles size={18} />
      {t("title")}
      {(q.data?.unseen ?? 0) > 0 && <span className={styles.menuDot} role="img" aria-label={t("buttonUnseen")} />}
    </button>
  );
}

/** แผงมีอะไรใหม่แบบเต็มจอของมือถือ (ปุ่มกลับ · อ่านทั้งหมดแล้ว) */
export function WhatsNewFullScreen({ ws, role }: { ws: string; role: Role }) {
  const t = useTranslations("whats-new");
  const p = usePanel(ws, role);
  const open = useFullScreen();
  const started = useRef(false);
  // เปิดแล้ว = เห็นแล้ว (ครั้งเดียวต่อการเปิด)
  useEffect(() => {
    if (open && !started.current && p.q.data) {
      started.current = true;
      p.open();
    }
    if (!open) started.current = false;
  }, [open, p]);
  useEffect(() => () => fullScreen.set(false), []);
  const close = () => {
    fullScreen.set(false);
    p.close();
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Content className={styles.full} aria-describedby={undefined}>
          <Panel
            ws={ws}
            items={p.items}
            query={p.q}
            onNavigate={close}
            onMarkAll={p.markAll}
            header={
              <div className={styles.fullHead}>
                <RadixDialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label={t("back")}>
                    <ArrowLeft size={20} />
                  </Button>
                </RadixDialog.Close>
                <RadixDialog.Title className={styles.title}>{t("title")}</RadixDialog.Title>
                {p.items.length > 0 && (
                  <button type="button" className={styles.link} onClick={p.markAll}>
                    {t("markAll")}
                  </button>
                )}
              </div>
            }
          />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
