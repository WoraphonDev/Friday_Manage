"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Dialog, ErrorState, Forbidden, LoadingState, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { keys, useMe } from "@/lib/query";
import { can, type Need } from "@/lib/roles";
import type { Metrics, OpenSession, Staff } from "@/lib/types";
import { EnrollForm } from "../auth/EnrollForm";

const NAV: { href: string; key: "overview" | "workspaces" | "payments" | "support" | "flags"; need?: Need }[] = [
  { href: "/", key: "overview" },
  { href: "/workspaces", key: "workspaces" },
  { href: "/payments", key: "payments", need: "finance" },
  { href: "/support", key: "support", need: "support" },
  { href: "/flags", key: "flags", need: "admin" },
];

/** แถบสีส้มด้านบนเมื่อพนักงานคนนี้มี support session เปิดอยู่ (Canvas: inSession) */
function SessionBanner({ staff }: { staff: Staff }) {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: () => api.get<{ items: OpenSession[] }>("/support-sessions"), enabled: can(staff.role, "support") });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => {
      toast(t("session.ended"));
      void cache.invalidateQueries({ queryKey: keys.sessions });
      void cache.invalidateQueries({ queryKey: ["ops", "workspace"] });
    },
    onError: (e) => toast(e.message),
  });
  const mine = sessions.data?.items.find((s) => s.staffId === staff.id);
  if (!mine) return null;
  return (
    <div className="session-banner" role="status">
      <b>{t("session.banner")}</b>
      <span>{t("session.detail", { workspace: mine.workspace.name, mode: t(`modes.${mine.mode}`), ticket: mine.ticketNo })}</span>
      <span className="grow" />
      <button type="button" disabled={end.isPending} onClick={() => end.mutate(mine.id)}>
        {t("session.end")}
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations("ops");
  const router = useRouter();
  const pathname = usePathname();
  const cache = useQueryClient();
  const me = useMe();
  const [addKey, setAddKey] = useState(false);
  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [unauthorized, router]);
  const staff = me.data;
  const metrics = useQuery({ queryKey: keys.metrics, queryFn: () => api.get<Metrics>("/metrics"), enabled: can(staff?.role, "finance") });
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => {
      cache.clear();
      router.replace("/login");
    },
  });

  if (me.isPending || unauthorized) return <LoadingState />;
  if (!staff) return <ErrorState error={me.error} retry={() => void me.refetch()} />;

  const current = NAV.filter((n) => (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href))).pop();
  const pending = metrics.data?.pendingPayments ?? 0;
  return (
    <>
      <SessionBanner staff={staff} />
      <div className="app">
        <aside className="side" aria-label={t("app.navLabel")}>
          <div className="brand">
            <span className="brand-mark">F</span>
            <div>
              <b>{t("app.name")}</b>
              <div className="brand-sub">{t("app.tagline")}</div>
            </div>
          </div>
          <div className="audited">{t("app.audited")}</div>
          <nav className="nav">
            {NAV.filter((n) => !n.need || can(staff.role, n.need)).map((n) => (
              <Link key={n.href} href={n.href} className={current?.href === n.href ? "nv on" : "nv"} aria-current={current?.href === n.href ? "page" : undefined}>
                {t(`nav.${n.key}`)}
                {n.key === "payments" && pending > 0 && <span className="pill warn nav-badge">{pending}</span>}
              </Link>
            ))}
          </nav>
          <div className="side-foot">
            <div>
              {staff.name} · {t(`roles.${staff.role}`)}
            </div>
            <div>{t("app.keyAuth")}</div>
            <div className="side-actions">
              <button type="button" className="side-link" onClick={() => setAddKey(true)}>
                {t("app.addKey")}
              </button>
              <button type="button" className="side-link" disabled={logout.isPending} onClick={() => logout.mutate()}>
                {t("app.signOut")}
              </button>
            </div>
          </div>
        </aside>
        <main className="main">{current?.need && !can(staff.role, current.need) ? <Forbidden need={[current.need]} /> : children}</main>
      </div>
      <Dialog open={addKey} onOpenChange={setAddKey} title={t("app.addKey")} description={t("auth.addKeyDesc")}>
        <EnrollForm mode="session" />
      </Dialog>
    </>
  );
}

export function PageHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <div className="muted">{desc}</div>
    </div>
  );
}

/** ใช้ในหน้า: คืนพนักงานที่ล็อกอินอยู่ (Shell โหลดไว้แล้ว) */
export function useStaff() {
  return useMe().data;
}
