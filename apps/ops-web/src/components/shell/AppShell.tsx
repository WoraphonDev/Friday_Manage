"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { KeyRound, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { ShortcutHelp } from "../shortcut-help";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type Mine, useLeft } from "@/lib/jit";
import { LoginMethods } from "@/features/auth/LoginMethods";
import { loginWithCode, loginWithPassword } from "@/features/auth/password";
import { keyErrorKind, loginWithKey } from "@/features/auth/webauthn";
import { api, ApiError, OPS_UNAUTHORIZED } from "@/lib/api";
import { keys, useMe } from "@/lib/query";
import type { OpenSession, SessionsResponse, Staff } from "@/lib/types";
import { hasAny, rolesOf } from "../access";
import { ApprovalFlowProvider, ApprovalsDrawer, ReauthProvider } from "../dialogs";
import { ErrorBlock, Modal, NoAccess, Notice, Seg } from "../kit";
import { Button, InlineError, Input, LoadingState, Textarea, useToast } from "../ui";
import { BreakGlassDialog } from "./BreakGlass";
import { currentItem } from "./nav";
import { Sidebar } from "./Sidebar";
import styles from "./session.module.css";
import { SearchPalette, Topbar } from "./Topbar";

const MIN = 60_000;
/** เตือนก่อนหมด (H8) */
const WARN_MS = 5 * MIN;
/** รวมทั้งครั้งที่เข้าไม่เกิน 2 ชม. (ops-api › SESSION_MAX_MINUTES) */
const SESSION_MAX_MS = 120 * MIN;
const EXTEND_OPTIONS = ["15", "30", "60"] as const;
type SessionsData = SessionsResponse & { offset: number };

/** เวลาที่เหลือเป็น mm:ss (เกินชั่วโมงเป็น h:mm:ss) */
export function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

/** แถบส้ม (G11 · H8): พนักงานคนนี้กำลังเข้าบัญชีลูกค้า · นับถอยหลังจาก expires_at ของเซิร์ฟเวอร์ · ขยายเวลาได้ · เตือนเหลือ 5 นาที */
function SessionBanner({ staff }: { staff: Staff }) {
  const t = useTranslations("common.banner");
  const ts = useTranslations("ss.session");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const sessions = useQuery({
    queryKey: keys.sessions,
    // ปรับนาฬิกาเครื่องให้ตรงเซิร์ฟเวอร์ครั้งละการโหลด: นับถอยหลังตามเวลาหมดของเซิร์ฟเวอร์ ไม่ใช่นาฬิกาเครื่อง
    queryFn: async (): Promise<SessionsData> => {
      const r = await api.get<SessionsResponse>("/support-sessions");
      return { ...r, offset: r.serverTime ? Date.parse(r.serverTime) - Date.now() : 0 };
    },
    enabled: hasAny(staff, "support", "owner"),
    refetchInterval: 60_000,
  });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => {
      toast(t("sessionEnded"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  const mine = sessions.data?.items.find((s) => s.staffId === staff.id);
  const offset = sessions.data?.offset ?? 0;
  const expiresAt = mine?.expiresAt ? Date.parse(mine.expiresAt) : null;
  const [now, setNow] = useState(() => Date.now() + offset);
  const [extending, setExtending] = useState(false);
  const [warned, setWarned] = useState<string | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now() + offset);
    const timer = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, offset]);
  const left = expiresAt === null ? null : expiresAt - now;
  // เตือนครั้งเดียวต่อเวลาหมด (ขยายแล้วเตือนใหม่ได้) · หมดเวลา = แจ้งครั้งเดียวแล้วโหลดรายการใหม่ (เซิร์ฟเวอร์ปิดให้แล้ว)
  const mark = mine && mine.expiresAt ? `${mine.id}:${mine.expiresAt}` : null;
  useEffect(() => {
    if (!mine || left === null || !mark) return;
    if (left <= 0) {
      if (expired === mark) return;
      setExpired(mark);
      setWarnOpen(false);
      toast(ts("expired", { workspace: mine.workspace.name, minutes: Math.max(1, Math.round((expiresAt! - Date.parse(mine.startedAt)) / MIN)) }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    } else if (left <= WARN_MS && warned !== mark) {
      setWarned(mark);
      setWarnOpen(true);
    }
  }, [left, mark, mine, expired, warned, expiresAt, toast, ts, cache]);
  if (!mine || (left !== null && left <= 0)) return null;
  const time = (ms: number) => format.dateTime(new Date(ms), { timeStyle: "short" });
  return (
    <>
      <div className="ops-banner ops-banner-session" role="status">
        <span>
          {ts("inside")} <b>{mine.workspace.name}</b> · {ts("detail", { mode: mine.mode === "write" ? t("modeWrite") : t("modeRead"), ticket: mine.ticketNo })}
        </span>
        <span className="grow" />
        {expiresAt !== null && left !== null && (
          <span className={styles.timer}>
            {ts("left")}{" "}
            <span key={warned === mark ? "warn" : "ok"} className={clsx(styles.count, left <= WARN_MS && styles.pulse)} data-testid="session-countdown">
              {countdown(left)}
            </span>
            <span className={styles.until}>{ts("until", { time: time(expiresAt) })}</span>
          </span>
        )}
        {expiresAt !== null && (
          <button type="button" onClick={() => setExtending(true)}>
            {ts("extend")}
          </button>
        )}
        <button type="button" className={styles.solid} disabled={end.isPending} onClick={() => end.mutate(mine.id)}>
          {t("sessionEnd")}
        </button>
      </div>
      {warnOpen && (
        <div className={styles.warnRegion}>
          <div className="toast" role="status">
            <span className="toast-icon" aria-hidden="true">
              !
            </span>
            <span className="toast-body">
              <span>{ts("warn", { workspace: mine.workspace.name })}</span>
            </span>
            <span className={styles.warnActions}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setWarnOpen(false);
                  setExtending(true);
                }}
              >
                {ts("warnExtend")}
              </button>
              <Button size="icon" variant="ghost" aria-label={ts("dismiss")} onClick={() => setWarnOpen(false)}>
                <X size={16} />
              </Button>
            </span>
          </div>
        </div>
      )}
      {extending && <ExtendSessionDialog session={mine} offset={offset} onClose={() => setExtending(false)} />}
    </>
  );
}

/** H9 · ขยายเวลา 15 / 30 / 60 นาที · รวม ≤ 2 ชม. ต่อครั้งที่เข้า และไม่เกินวันที่ลูกค้าอนุญาต (เซิร์ฟเวอร์ตัดให้) */
function ExtendSessionDialog({ session, offset, onClose }: { session: OpenSession; offset: number; onClose: () => void }) {
  const ts = useTranslations("ss.session");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const [minutes, setMinutes] = useState<(typeof EXTEND_OPTIONS)[number]>("30");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  // ลูกค้าอนุญาตถึงวันไหน: อ่านจากหน้ารายละเอียดลูกค้า (ถ้าอ่านไม่ได้ก็ไม่แสดงส่วนนี้)
  const grant = useQuery({
    queryKey: ["ops", "workspace", session.workspaceId, "grant"],
    queryFn: () => api.get<{ supportAccess?: { until: string | null } | null }>(`/workspaces/${session.workspaceId}`),
    retry: false,
  });
  const time = (ms: number) => format.dateTime(new Date(ms), { timeStyle: "short" });
  const start = Date.parse(session.startedAt);
  const current = session.expiresAt ? Date.parse(session.expiresAt) : Date.now() + offset;
  const until = grant.data?.supportAccess?.until ? Date.parse(grant.data.supportAccess.until) : null;
  const next = Math.min(current + Number(minutes) * MIN, start + SESSION_MAX_MS, until ?? Infinity);
  const extend = useMutation({
    mutationFn: () => api.post<{ session: OpenSession }>(`/support-sessions/${session.id}/extend`, { minutes: Number(minutes), reason: reason.trim() }),
    onSuccess: (r) => {
      toast(ts("extended", { time: time(Date.parse(r.session.expiresAt ?? new Date(next).toISOString())) }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  const ok = reason.trim().length >= 5;
  const desc = until
    ? ts("extendDescGrant", { start: time(start), end: time(current), until: format.dateTime(new Date(until), { dateStyle: "medium" }) })
    : ts("extendDesc", { start: time(start), end: time(current) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={ts("extendTitle", { workspace: session.workspace.name })} description={desc}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (ok) extend.mutate();
        }}
      >
        <div className="field">
          <span className="field-label">{ts("extendBy")}</span>
          <Seg label={ts("extendBy")} value={minutes} onChange={setMinutes} options={EXTEND_OPTIONS.map((m) => ({ value: m, label: ts("minutes", { n: Number(m) }) }))} />
          <span className="muted small">{ts("newEnd", { time: time(next) })}</span>
        </div>
        <Textarea label={ts("reason")} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} error={touched && !ok ? ts("reasonMin") : undefined} />
        <Notice tone="info">{ts("notifyInfo")}</Notice>
        <InlineError error={extend.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {ts("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={extend.isPending}>
            {ts("submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * แถบนับถอยหลังสิทธิ์ชั่วคราว (A12 + O52) ทุกหน้า: บทบาท · เวลาที่เหลือ · ใครอนุมัติ · Ticket · คืนสิทธิ์ได้เลย
 * อ่าน /jit/me ทุก 30 วินาที → ได้รับอนุมัติแล้วแจ้งทันทีและโหลดสิทธิ์ใหม่ (เมนูที่ได้เพิ่มโผล่) · หมดเวลาแล้วโหลดสิทธิ์ใหม่
 */
function ElevationBanner() {
  const t = useTranslations("jit.banner");
  const tc = useTranslations("common");
  const left = useLeft();
  const toast = useToast();
  const cache = useQueryClient();
  const mine = useQuery({ queryKey: ["ops", "jit", "me"], queryFn: () => api.get<Mine>("/jit/me"), refetchInterval: 30_000 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  const active = mine.data?.active ?? [];
  const live = active.filter((a) => Date.parse(a.endsAt) > now).sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!mine.data) return;
    const ids = new Set(mine.data.active.map((a) => a.id));
    if (seen.current) {
      const granted = mine.data.active.filter((a) => a.kind === "approved" && !seen.current!.has(a.id));
      for (const a of granted) toast(t("granted", { role: tc(`roles.${a.role}`) }));
      if (granted.length) void cache.invalidateQueries({ queryKey: keys.me });
    }
    seen.current = ids;
  }, [mine.data, toast, t, tc, cache]);
  useEffect(() => {
    if (active.length > live.length) void cache.invalidateQueries({ queryKey: ["ops"] });
  }, [active.length, live.length, cache]);
  const end = useMutation({
    mutationFn: async () => {
      for (const e of live) await api.post(`/staff/me/elevations/${e.id}/end`);
    },
    onSuccess: () => (toast(t("ended")), void cache.invalidateQueries({ queryKey: ["ops"] })),
  });
  if (!live.length) return null;
  const first = live[0];
  const roles = [...new Set(live.map((a) => tc(`roles.${a.role}`)))].join(", ");
  const soon = Date.parse(first.endsAt) - now < 5 * 60_000;
  return (
    <div className="ops-banner ops-banner-elevated" role="alert">
      <b>⏱ {t("text", { roles, left: left(first.endsAt) })}</b>
      <span>
        {[first.kind === "approved" ? t("by", { name: first.approvedBy ?? "—" }) : t("glass"), first.ticketRef ? t("ticket", { ref: first.ticketRef }) : null, soon ? t("soon") : null].filter(Boolean).join(" · ")}
      </span>
      <span className="grow" />
      <button type="button" disabled={end.isPending} onClick={() => end.mutate()}>
        {t("end")}
      </button>
    </div>
  );
}

/** S3 · เซสชันหมดอายุระหว่างใช้งาน: ใส่รหัสผ่าน + รหัส 6 หลัก หรือแตะ Passkey เพื่อทำต่อจากหน้าเดิม (ข้อความที่พิมพ์ไว้ยังอยู่) */
function SessionExpired({ staff, onSignOut }: { staff: Staff; onSignOut: () => void }) {
  const t = useTranslations("common.expired");
  const ta = useTranslations("ops.auth");
  const toast = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPS_UNAUTHORIZED, on);
    return () => window.removeEventListener(OPS_UNAUTHORIZED, on);
  }, []);
  const resumed = () => {
    setOpen(false);
    setPassword("");
    setCode("");
    toast(t("resumed"));
    void cache.invalidateQueries();
  };
  const withPassword = useMutation({
    mutationFn: async () => loginWithCode((await loginWithPassword(staff.email, password)).mfaToken, code),
    onSuccess: resumed,
  });
  const withKey = useMutation({ mutationFn: () => loginWithKey(staff.email), onSuccess: resumed });
  const busy = withPassword.isPending || withKey.isPending;
  const kind = keyErrorKind(withKey.error);
  return (
    <Modal open={open} onOpenChange={() => undefined} title={t("title")} description={t("desc")}>
      <form
        className="dialog-body"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (password && /^\d{6}$/.test(code)) withPassword.mutate();
        }}
      >
        <Input label={ta("password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input label={ta("code")} className="auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        {kind ? <InlineError error={new Error(ta(kind))} /> : <InlineError error={withPassword.error ?? withKey.error} />}
        <div className="dialog-actions">
          <Button onClick={onSignOut}>{t("signOut")}</Button>
          <Button disabled={busy} onClick={() => withKey.mutate()}>
            <KeyRound size={16} />
            {withKey.isPending ? ta("waiting") : ta("useKey")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !password || code.length !== 6}>
            {withPassword.isPending ? ta("working") : t("resume")}
          </Button>
        </div>
      </form>
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
            <ElevationBanner />
            <SessionBanner staff={staff} />
            <main className="ops-main">
              {allowed ? (
                children
              ) : (
                <NoAccess
                  need={current!.roles}
                  mine={rolesOf(staff)}
                  onBreakGlass={(staff.roles ?? []).includes("owner") ? () => setGlass(true) : undefined}
                  onRequest={(staff.roles ?? []).includes("owner") ? undefined : () => router.push(`/jit?request=${current!.roles.find((r) => r !== "owner") ?? ""}`)}
                />
              )}
            </main>
          </div>
        </div>
        <SearchPalette staff={staff} open={searchOpen} onOpenChange={setSearchOpen} onApprovals={openApprovals} />
        <ApprovalsDrawer open={approvals} onOpenChange={setApprovals} />
        <ShortcutHelp />
        <BreakGlassDialog staff={staff} open={glass} onOpenChange={setGlass} initialRole={current && !allowed ? current.roles.find((r) => r !== "owner") : undefined} />
        <Modal open={addKey} onOpenChange={setAddKey} title={t("account.methods")} description={ta("methodsDesc")}>
          <LoginMethods />
        </Modal>
        <SessionExpired staff={staff} onSignOut={() => logout.mutate()} />
      </ApprovalFlowProvider>
    </ReauthProvider>
  );
}
