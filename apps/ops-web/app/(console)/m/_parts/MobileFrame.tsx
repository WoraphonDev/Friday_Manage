"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CheckCircle2, Menu, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { hasAny } from "@/components/access";
import { Button, errorToast, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";

const TABS = [
  { key: "approvals", href: "/m/approvals", icon: CheckCircle2, roles: ["owner"] },
  { key: "payments", href: "/m/payments", icon: Wallet, roles: ["finance", "owner"] },
  { key: "incidents", href: "/m/incidents", icon: AlertTriangle, roles: ["engineer", "support", "owner"] },
] as const;

/** แท็บที่บทบาทนี้เปิดได้ (หน้า /m เลือกแท็บแรก) */
export function useMobileTabs() {
  const me = useMe().data;
  return TABS.filter((t) => hasAny(me, ...t.roles));
}

/** กรอบหน้ามือถือ (M6): เนื้อหาคอลัมน์เดียว + แถบล่าง (อนุมัติ · คิวชำระ · เหตุขัดข้อง · เมนู) */
export function MobileFrame({ children }: { children: ReactNode }) {
  const t = useTranslations("mob.tabs");
  const path = usePathname();
  const tabs = useMobileTabs();
  return (
    <div className="m-app">
      <PushCard />
      {children}
      <nav className="m-tabs" aria-label={t("label")}>
        {tabs.map(({ key, href, icon: Icon }) => (
          <Link key={key} href={href} className="m-tab" aria-current={path?.startsWith(href) ? "page" : undefined}>
            <Icon size={20} aria-hidden="true" />
            {t(key)}
          </Link>
        ))}
        <Link href="/" className="m-tab">
          <Menu size={20} aria-hidden="true" />
          {t("menu")}
        </Link>
      </nav>
    </div>
  );
}

const b64ToBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
type PushStatus = { enabled: boolean; publicKey: string | null; devices: number };
const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** เปิด / ปิดแจ้งเตือนในเครื่องนี้ (Web Push) */
export function PushCard() {
  const t = useTranslations("mob.push");
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: ["ops", "push"], queryFn: () => api.get<PushStatus>("/push") });
  const [here, setHere] = useState<PushSubscription | null | undefined>(undefined);
  const [can, setCan] = useState(true);
  useEffect(() => {
    if (!supported()) return setCan(false);
    void navigator.serviceWorker
      .getRegistration("/")
      .then((r) => r?.pushManager.getSubscription() ?? null)
      .then(setHere)
      .catch(() => setHere(null));
  }, []);
  const on = useMutation({
    mutationFn: async () => {
      if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") throw new Error(t("denied"));
      const reg = await navigator.serviceWorker.register("/ops-sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(q.data!.publicKey!) }));
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api.post("/push/subscriptions", { endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent.slice(0, 300) });
      return sub;
    },
    onSuccess: (sub) => (setHere(sub), toast(t("enabled")), void cache.invalidateQueries({ queryKey: ["ops", "push"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const off = useMutation({
    mutationFn: async () => {
      if (!here) return;
      await api.post("/push/subscriptions/remove", { endpoint: here.endpoint });
      await here.unsubscribe();
    },
    onSuccess: () => (setHere(null), toast(t("removed")), void cache.invalidateQueries({ queryKey: ["ops", "push"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const test = useMutation({ mutationFn: () => api.post<{ devices: number }>("/push/test", {}), onSuccess: (r) => toast(t("tested", { n: r.devices })), onError: (e) => toast(errorToast(e)) });
  if (!q.data) return null;
  if (here) {
    return (
      <div className="m-push m-push-on">
        <BellRing size={16} aria-hidden="true" />
        <span className="spacer small">{t("on", { n: q.data.devices })}</span>
        <Button size="small" onClick={() => test.mutate()} disabled={test.isPending}>
          {t("test")}
        </Button>
        <Button size="small" variant="ghost" onClick={() => off.mutate()} disabled={off.isPending}>
          {t("disable")}
        </Button>
      </div>
    );
  }
  return (
    <section className="m-push" aria-label={t("title")}>
      <BellRing size={18} aria-hidden="true" />
      <span className="spacer small">
        <b>{t("title")}</b>
        <br />
        <span className="muted">{!q.data.enabled ? t("disabled") : !can ? t("unsupported") : t("off")}</span>
      </span>
      {q.data.enabled && can && here !== undefined && (
        <Button variant="primary" className="m-btn" onClick={() => on.mutate()} disabled={on.isPending}>
          {t("enable")}
        </Button>
      )}
    </section>
  );
}

/** หัวหน้าจอมือถือ */
export function MobileHead({ title, sub, back }: { title: string; sub?: ReactNode; back?: { label: string; onClick: () => void } }) {
  return (
    <header className="m-head">
      {back && (
        <button type="button" className="m-back" aria-label={back.label} onClick={back.onClick}>
          ‹
        </button>
      )}
      <h1 className="m-title">{title}</h1>
      {sub && <span className="m-sub">{sub}</span>}
    </header>
  );
}
