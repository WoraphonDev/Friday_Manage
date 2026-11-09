"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EnrollForm } from "@/features/auth/EnrollForm";
import { keyErrorKind, loginWithKey } from "@/features/auth/webauthn";
import { api, ApiError, OPS_UNAUTHORIZED } from "@/lib/api";
import { keys, useMe } from "@/lib/query";
import type { OpenSession, Staff } from "@/lib/types";
import { hasAny, rolesOf } from "../access";
import { ApprovalFlowProvider, ApprovalsDrawer, ReauthProvider } from "../dialogs";
import { ErrorBlock, Modal, NoAccess } from "../kit";
import { Button, InlineError, LoadingState, useToast } from "../ui";
import { BreakGlassDialog } from "./BreakGlass";
import { currentItem } from "./nav";
import { Sidebar } from "./Sidebar";
import { SearchPalette, Topbar } from "./Topbar";

/** แถบส้ม (G11): พนักงานคนนี้กำลังเข้าบัญชีลูกค้า */
function SessionBanner({ staff }: { staff: Staff }) {
  const t = useTranslations("common.banner");
  const toast = useToast();
  const cache = useQueryClient();
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: () => api.get<{ items: OpenSession[] }>("/support-sessions"), enabled: hasAny(staff, "support", "owner") });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => {
      toast(t("sessionEnded"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  const mine = sessions.data?.items.find((s) => s.staffId === staff.id);
  if (!mine) return null;
  return (
    <div className="ops-banner ops-banner-session" role="status">
      <b>{t("session")}</b>
      <span>{t("sessionDetail", { workspace: mine.workspace.name, mode: mine.mode === "write" ? t("modeWrite") : t("modeRead"), ticket: mine.ticketNo })}</span>
      <span className="grow" />
      <button type="button" disabled={end.isPending} onClick={() => end.mutate(mine.id)}>
        {t("sessionEnd")}
      </button>
    </div>
  );
}

/** แถบแดง: เปิดสิทธิ์ฉุกเฉินอยู่ (A12) · Owner ปิดก่อนหมดเวลาได้ */
function ElevationBanner({ staff }: { staff: Staff }) {
  const t = useTranslations("common");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const elevated = staff.elevated ?? [];
  const list = useQuery({ queryKey: ["ops", "staff"], queryFn: () => api.get<{ items: { id: string; elevations: { id: string; role: string; endsAt: string }[] }[] }>("/staff"), enabled: elevated.length > 0 });
  const mine = list.data?.items.find((s) => s.id === staff.id)?.elevations ?? [];
  const end = useMutation({
    mutationFn: async () => {
      for (const e of mine) await api.post(`/staff/me/elevations/${e.id}/end`);
    },
    onSuccess: () => {
      toast(t("banner.elevatedEnded"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  if (!elevated.length) return null;
  const until = mine.length ? new Date(Math.max(...mine.map((e) => Date.parse(e.endsAt)))) : null;
  return (
    <div className="ops-banner ops-banner-elevated" role="alert">
      <b>{t("banner.elevated", { roles: elevated.map((r) => t(`roles.${r}`)).join(", ") })}</b>
      {until && <span>{t("banner.elevatedDetail", { time: format.dateTime(until, { timeStyle: "short" }) })}</span>}
      <span className="grow" />
      {mine.length > 0 && (
        <button type="button" disabled={end.isPending} onClick={() => end.mutate()}>
          {t("banner.elevatedEnd")}
        </button>
      )}
    </div>
  );
}

/** S3 · เซสชันหมดอายุระหว่างใช้งาน: แตะกุญแจเพื่อทำต่อจากหน้าเดิม (ข้อความที่พิมพ์ไว้ยังอยู่) */
function SessionExpired({ staff, onSignOut }: { staff: Staff; onSignOut: () => void }) {
  const t = useTranslations("common.expired");
  const ta = useTranslations("ops.auth");
  const toast = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPS_UNAUTHORIZED, on);
    return () => window.removeEventListener(OPS_UNAUTHORIZED, on);
  }, []);
  const resume = useMutation({
    mutationFn: () => loginWithKey(staff.email),
    onSuccess: () => {
      setOpen(false);
      toast(t("resumed"));
      void cache.invalidateQueries();
    },
  });
  const kind = keyErrorKind(resume.error);
  return (
    <Modal open={open} onOpenChange={() => undefined} title={t("title")} description={t("desc")}>
      <div className="dialog-body">
        {kind ? <InlineError error={new Error(ta(kind))} /> : <InlineError error={resume.error} />}
        <div className="dialog-actions">
          <Button onClick={onSignOut}>{t("signOut")}</Button>
          <Button variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
            <KeyRound size={16} />
            {resume.isPending ? ta("waiting") : t("resume")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** โครงหน้าของ Friday Ops (O10): เมนูซ้ายตามบทบาท · แถบบน · แถบแจ้ง · Modal กลาง · ตรวจสิทธิ์ของหน้าที่เปิดจากลิงก์ตรง */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("common");
  const ta = useTranslations("ops.auth");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const cache = useQueryClient();
  const me = useMe();
  const [searchOpen, setSearchOpen] = useState(false);
  const [approvals, setApprovals] = useState(false);
  const [addKey, setAddKey] = useState(false);
  const [glass, setGlass] = useState(false);
  const [menu, setMenu] = useState(false);
  const unauthorized = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/login");
  }, [unauthorized, router]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => {
      cache.clear();
      router.replace("/login");
    },
  });
  const openApprovals = useCallback(() => setApprovals(true), []);
  useEffect(() => {
    document.body.dataset.opsShell = "1";
    return () => {
      delete document.body.dataset.opsShell;
    };
  }, []);

  if (me.isPending || unauthorized) return <LoadingState />;
  if (!me.data) return <ErrorBlock error={me.error} retry={() => void me.refetch()} />;
  const staff = me.data;
  const current = currentItem(pathname, search);
  const allowed = !current || hasAny(staff, ...current.roles);

  return (
    <ReauthProvider>
      <ApprovalFlowProvider>
        <div className="ops-app">
          <Sidebar staff={staff} pathname={pathname} search={search} open={menu} onNavigate={() => setMenu(false)} />
          <div className="ops-content">
            <Topbar
              staff={staff}
              current={current}
              onSearch={() => setSearchOpen(true)}
              onApprovals={openApprovals}
              onAddKey={() => setAddKey(true)}
              onBreakGlass={() => setGlass(true)}
              onSignOut={() => logout.mutate()}
              onMenu={() => setMenu((v) => !v)}
            />
            <ElevationBanner staff={staff} />
            <SessionBanner staff={staff} />
            <main className="ops-main">
              {allowed ? (
                children
              ) : (
                <NoAccess need={current!.roles} mine={rolesOf(staff)} onBreakGlass={(staff.roles ?? []).includes("owner") ? () => setGlass(true) : undefined} />
              )}
            </main>
          </div>
        </div>
        <SearchPalette staff={staff} open={searchOpen} onOpenChange={setSearchOpen} onApprovals={openApprovals} />
        <ApprovalsDrawer open={approvals} onOpenChange={setApprovals} />
        <BreakGlassDialog staff={staff} open={glass} onOpenChange={setGlass} initialRole={current && !allowed ? current.roles.find((r) => r !== "owner") : undefined} />
        <Modal open={addKey} onOpenChange={setAddKey} title={t("account.addKey")} description={ta("addKeyDesc")}>
          <EnrollForm mode="session" />
        </Modal>
        <SessionExpired staff={staff} onSignOut={() => logout.mutate()} />
      </ApprovalFlowProvider>
    </ReauthProvider>
  );
}
