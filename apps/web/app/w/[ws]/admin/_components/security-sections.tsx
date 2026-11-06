"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { addDays, format, parseISO } from "date-fns";
import { Button, Dialog, EmptyState, ErrorState, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, today } from "@/lib/format";
import { Card, Closed, OptionGroup, patch, Switch, usePatchSettings, useSettings } from "./shared";
import {
  adminKey, errorText, formatBytes, wsPath,
  type AuditCategory, type AuditEntry, type DataRequest, type MfaEnforcement, type SecurityPolicy, type SupportAccess, type WorkspaceExport, type WorkspaceMember,
} from "./types";
import styles from "./admin.module.css";

const thTime = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const when = (iso: string) => thTime.format(new Date(iso));
/** ตัวเลือกตาม Canvas + ค่าปัจจุบัน (ถ้าตั้งไว้นอกตัวเลือก) */
const withCurrent = <T,>(list: T[], current: T) => (list.includes(current) ? list : [...list, current]);

// ---------------------------------------------------------------------------
// ความปลอดภัย & SSO
// ---------------------------------------------------------------------------

type PolicyForm = Omit<SecurityPolicy, "mfa">;
const toForm = (p: SecurityPolicy): PolicyForm => ({
  passwordMinLength: p.passwordMinLength,
  passwordRequireSpecial: p.passwordRequireSpecial,
  passwordRotationDays: p.passwordRotationDays,
  lockoutAttempts: p.lockoutAttempts,
  lockoutMinutes: p.lockoutMinutes,
  sessionIdleHours: p.sessionIdleHours,
  mfaEnforcement: p.mfaEnforcement,
  allowedEmailDomains: p.allowedEmailDomains,
  ipAllowlist: p.ipAllowlist,
});
const lines = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export function SecuritySection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.security");
  const policy = useQuery({ queryKey: adminKey(ws, "security"), queryFn: () => api.get<SecurityPolicy>(`${wsPath(ws)}/security-policy`) });
  return (
    <>
      <SupportAccessCard ws={ws} />
      <Card title={<>{t("ssoTitle")} <span className={`${styles.pill} ${styles.ent}`}>{t("enterprise")}</span></>}>
        <Closed title={t("ssoClosed")} description={t("ssoClosedHint")} />
      </Card>
      {policy.error ? (
        <ErrorState error={policy.error} retry={() => void policy.refetch()} />
      ) : !policy.data ? (
        <LoadingState />
      ) : (
        <PolicyForm key={JSON.stringify(toForm(policy.data))} ws={ws} policy={policy.data} />
      )}
    </>
  );
}

function PolicyForm({ ws, policy }: { ws: string; policy: SecurityPolicy }) {
  const t = useTranslations("admin-automation.admin.security");
  const cache = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => toForm(policy));
  const [domains, setDomains] = useState(policy.allowedEmailDomains.join("\n"));
  const [ips, setIps] = useState(policy.ipAllowlist.join("\n"));
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const next: PolicyForm = { ...form, allowedEmailDomains: lines(domains.toLowerCase()), ipAllowlist: lines(ips) };
  const before = toForm(policy);
  const changes = Object.fromEntries((Object.keys(next) as (keyof PolicyForm)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k])).map((k) => [k, next[k]]));
  const dirty = Object.keys(changes).length > 0;
  const mfa = policy.mfa;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await patch(`${wsPath(ws)}/security-policy`, changes);
      toast({ message: t("saved") });
      await cache.invalidateQueries({ queryKey: adminKey(ws, "security") });
    } catch (e) {
      if (e instanceof ApiError && e.code === "ip_allowlist_locks_you_out") setError({ field: "ip", message: t("lockoutSelf", { ip: String(e.details.yourIp ?? "—") }) });
      else if (e instanceof ApiError && e.code === "invalid_ip_allowlist") setError({ field: "ip", message: e.message });
      else toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  const mfaOptions: { value: MfaEnforcement; title: string; description: string }[] = (["none", "admin", "all"] as const).map((v) => ({ value: v, title: t(`mfa_${v}`), description: t(`mfa_${v}Hint`) }));
  return (
    <>
      <Card title={t("mfaTitle")} actions={mfa && <span className={`${styles.pill} ${mfa.enabled === mfa.total ? styles.ok : styles.warn}`}>{t("mfaCount", { n: mfa.enabled, total: mfa.total })}</span>}>
        <OptionGroup label={t("mfaTitle")} value={form.mfaEnforcement} options={mfaOptions} onChange={(v) => set("mfaEnforcement", v)} />
        {mfa && mfa.missing.length > 0 && (
          <div className={styles.hint}>
            <b>{t("mfaMissing", { n: mfa.missing.length })}</b>
            <div className={styles.muted}>{mfa.missing.map((m) => m.displayName).join(", ")}</div>
          </div>
        )}
      </Card>
      <Card title={t("policyTitle")}>
        <div className={styles.grid}>
          <Select label={t("minLength")} value={String(form.passwordMinLength)} onChange={(e) => set("passwordMinLength", Number(e.target.value))}>
            {withCurrent([8, 10, 12], form.passwordMinLength).map((n) => <option key={n} value={n}>{t("chars", { n })}</option>)}
          </Select>
          <Select label={t("rotation")} value={form.passwordRotationDays === null ? "" : String(form.passwordRotationDays)} onChange={(e) => set("passwordRotationDays", e.target.value ? Number(e.target.value) : null)}>
            {withCurrent<number | null>([null, 90, 180], form.passwordRotationDays).map((n) => <option key={String(n)} value={n ?? ""}>{n === null ? t("noRotation") : t("everyDays", { n })}</option>)}
          </Select>
          <Select label={t("lockout")} value={String(form.lockoutAttempts)} hint={t("lockoutHint", { m: form.lockoutMinutes })} onChange={(e) => set("lockoutAttempts", Number(e.target.value))}>
            {withCurrent([3, 5, 10], form.lockoutAttempts).map((n) => <option key={n} value={n}>{t("attempts", { n })}</option>)}
          </Select>
          <Select label={t("session")} value={String(form.sessionIdleHours)} onChange={(e) => set("sessionIdleHours", Number(e.target.value))}>
            {withCurrent([1, 8, 24], form.sessionIdleHours).map((n) => <option key={n} value={n}>{t("hours", { n })}</option>)}
          </Select>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={form.passwordRequireSpecial} onChange={(e) => set("passwordRequireSpecial", e.target.checked)} />
          {t("requireSpecial")}
        </label>
        <div className={styles.grid}>
          <div className={styles.fld}>
            <label className={styles.lb} htmlFor="sec-domains">{t("domains")}</label>
            <textarea id="sec-domains" className={styles.in} value={domains} placeholder="example.com" onChange={(e) => setDomains(e.target.value)} />
            <span className={styles.muted}>{t("domainsHint")}</span>
          </div>
          <div className={styles.fld}>
            <label className={styles.lb} htmlFor="sec-ips">{t("ip")}</label>
            <textarea id="sec-ips" className={`${styles.in} ${styles.mono}`} value={ips} placeholder="203.0.113.0/24" aria-invalid={error?.field === "ip" || undefined} onChange={(e) => setIps(e.target.value)} />
            {error?.field === "ip" ? <span className="field-error" role="alert">{error.message}</span> : <span className={styles.muted}>{t("ipHint")}</span>}
          </div>
        </div>
        <span className={styles.muted}>{t("enforceNote")}</span>
        <div className={styles.actions}>
          {dirty && <Button onClick={() => { setForm(toForm(policy)); setDomains(policy.allowedEmailDomains.join("\n")); setIps(policy.ipAllowlist.join("\n")); setError(null); }}>{t("reset")}</Button>}
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? t("saving") : t("save")}</Button>
        </div>
      </Card>
    </>
  );
}

function SupportAccessCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.support");
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "support");
  const access = useQuery({ queryKey: key, queryFn: () => api.get<SupportAccess>(`${wsPath(ws)}/support-access`) });
  const [duration, setDuration] = useState<"forever" | "30d" | "7d">("forever");
  const [mode, setMode] = useState<"read" | "write" | null>(null);
  const isOwner = workspace.role === "owner";
  const a = access.data;
  async function put(enabled: boolean) {
    try {
      const next = await api.put<SupportAccess>(`${wsPath(ws)}/support-access`, { enabled, duration, maxMode: mode ?? a?.maxMode ?? "read", notifyAdmins: true });
      cache.setQueryData(key, next);
      toast({ message: enabled ? t("enabledToast") : t("disabledToast") });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const last = a?.sessions[0];
  return (
    <Card title={t("title")} actions={a && <span className={`${styles.pill} ${a.enabled ? styles.ok : styles.neu}`}>{a.enabled ? t("on") : a.expired ? t("expired") : t("off")}</span>}>
      {access.error ? (
        <ErrorState error={access.error} retry={() => void access.refetch()} />
      ) : !a ? (
        <LoadingState />
      ) : (
        <>
          <div className={styles.switchRow}>
            <Switch checked={a.enabled} label={t("toggle")} disabled={!isOwner} onChange={(v) => void put(v)} />
            <div>
              <b>{t("toggle")}</b>
              <div className={styles.muted}>{t("hint")}</div>
              {!isOwner && <div className={styles.muted}>{t("ownerOnly")}</div>}
            </div>
          </div>
          <div className={styles.grid}>
            <Select label={t("until")} value={duration} disabled={!isOwner} hint={a.until ? t("untilDate", { date: formatDate(a.until, "BE", true) }) : undefined} onChange={(e) => setDuration(e.target.value as typeof duration)}>
              <option value="forever">{t("forever")}</option>
              <option value="30d">{t("days30")}</option>
              <option value="7d">{t("days7")}</option>
            </Select>
            <Select label={t("mode")} value={mode ?? a.maxMode} disabled={!isOwner} onChange={(e) => setMode(e.target.value as "read" | "write")}>
              <option value="read">{t("read")}</option>
              <option value="write">{t("write")}</option>
            </Select>
          </div>
          {isOwner && a.enabled && <div><Button size="small" onClick={() => void put(true)}>{t("update")}</Button></div>}
          <div className={styles.row}>
            <span className={styles.grow}>
              <b>{t("last")}</b>
              <div className={styles.muted}>{last ? t("lastText", { at: when(last.startedAt), ticket: last.ticketNo, mode: t(last.mode === "write" ? "write" : "read"), min: last.durationMinutes ?? 0 }) : t("never")}</div>
            </span>
            <Link className="button button-secondary button-small" href={`${wsPath(ws)}/admin/audit`}>{t("viewAudit")}</Link>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

const CATEGORIES: ("all" | AuditCategory)[] = ["all", "perm", "data", "secu", "plan", "notify"];
const CAT_TONE: Record<AuditCategory, string> = { perm: "ent", data: "neu", secu: "bad", plan: "warn", notify: "ok" };

export function AuditSection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.audit");
  const [category, setCategory] = useState<"all" | AuditCategory>("all");
  const [user, setUser] = useState("");
  const [range, setRange] = useState<"7d" | "30d" | "custom">("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const members = useQuery({ queryKey: ["workspace-members", ws], queryFn: () => api.get<{ items: WorkspaceMember[] }>(`${wsPath(ws)}/members`) });
  const now = today();
  const params = new URLSearchParams();
  if (category !== "all") params.set("category", category);
  if (user) params.set("user", user);
  if (range === "custom") {
    if (from) params.set("from", from);
    if (to) params.set("to", to);
  } else {
    params.set("from", format(addDays(parseISO(now), range === "7d" ? -6 : -29), "yyyy-MM-dd"));
    params.set("to", now);
  }
  const log = useInfiniteQuery({
    queryKey: adminKey(ws, "audit", params.toString()),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set("limit", "50");
      if (pageParam) p.set("before", pageParam);
      return api.get<{ items: AuditEntry[]; nextCursor: string | null }>(`${wsPath(ws)}/audit-log?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card
      title={t("title")}
      actions={<a className="button button-secondary" href={`/api/v1${wsPath(ws)}/audit-log.csv?${params}`} download>{t("csv")}</a>}
    >
      <div className={styles.chips} role="group" aria-label={t("category")}>
        {CATEGORIES.map((c) => <button key={c} type="button" className={styles.chip} aria-pressed={category === c} onClick={() => setCategory(c)}>{t(`cat_${c}`)}</button>)}
      </div>
      <div className={styles.chips}>
        <Select aria-label={t("user")} value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">{t("everyone")}</option>
          {members.data?.items.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </Select>
        <div className={styles.chips} role="group" aria-label={t("range")}>
          {(["7d", "30d", "custom"] as const).map((r) => <button key={r} type="button" className={styles.chip} aria-pressed={range === r} onClick={() => setRange(r)}>{t(`range_${r}`)}</button>)}
        </div>
        {range === "custom" && (
          <>
            <input className={styles.in} style={{ width: 160 }} type="date" aria-label={t("from")} value={from} onChange={(e) => setFrom(e.target.value)} />
            <input className={styles.in} style={{ width: 160 }} type="date" aria-label={t("to")} value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
      </div>
      {log.error ? (
        <ErrorState error={log.error} retry={() => void log.refetch()} />
      ) : !log.data ? (
        <LoadingState />
      ) : items.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <div style={{ margin: "0 -18px" }} role="table" aria-label={t("title")}>
          <div className={`${styles.al} ${styles.alHead}`} role="row">
            <div role="columnheader">{t("at")}</div><div role="columnheader">{t("user")}</div><div role="columnheader">{t("action")}</div><div role="columnheader">{t("summary")}</div><div role="columnheader">IP</div>
          </div>
          {items.map((a) => (
            <div key={a.id} className={styles.al} role="row">
              <div role="cell" className={styles.muted}>{when(a.at)}</div>
              <div role="cell">{a.actor.displayName ?? (a.actor.kind === "user" ? "—" : t(`actor_${a.actor.kind === "staff" ? "staff" : "system"}`))}</div>
              <div role="cell"><span className={`${styles.pill} ${styles[CAT_TONE[a.category]]}`}>{t(`cat_${a.category}`)}</span></div>
              <div role="cell" style={{ minWidth: 0 }}><span className={styles.mono}>{a.action}</span><div>{a.summary}</div></div>
              <div role="cell" className={styles.mono}>{a.ip ?? "—"}</div>
            </div>
          ))}
        </div>
      )}
      {log.hasNextPage && <div><Button disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>{t("more")}</Button></div>}
      <span className={styles.muted}>{t("hint")}</span>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ข้อมูล & PDPA
// ---------------------------------------------------------------------------

export function DataSection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.data");
  const settings = useSettings(ws);
  const save = usePatchSettings(ws);
  if (settings.error) return <ErrorState error={settings.error} retry={() => void settings.refetch()} />;
  if (!settings.data) return <LoadingState />;
  const s = settings.data;
  return (
    <>
      <Card title={t("title")}>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("region")}</span>
          {/* ตอนนี้มี region เดียว (A18 คืน th-bangkok เสมอ) จึงแสดงเป็นข้อมูล ไม่ใช่ตัวเลือก */}
          <div className={styles.chips}>
            <span className={`${styles.pill} ${styles.ok}`}>{t("regionTh")}</span>
            <span className={styles.muted}>{t("regionSg")}</span>
          </div>
          <span className={styles.muted}>{t("regionHint")}</span>
        </div>
        <div className={styles.grid}>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("trash")}</span>
            <OptionGroup label={t("trash")} value={s.trashDays} options={[{ value: 30, title: t("trash30") }, { value: 90, title: t("trash90") }]} onChange={(v) => void save({ trashDays: v })} />
          </div>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("retention")}</span>
            <OptionGroup
              label={t("retention")}
              value={s.archiveRetentionYears}
              options={[{ value: null, title: t("keepForever") }, { value: 3, title: t("years", { n: 3 }) }, ...(s.archiveRetentionYears !== null && s.archiveRetentionYears !== 3 ? [{ value: s.archiveRetentionYears, title: t("years", { n: s.archiveRetentionYears }) }] : [])]}
              onChange={(v) => void save({ archiveRetentionYears: v })}
            />
          </div>
        </div>
        <ExportRow ws={ws} />
      </Card>
      <DataRequestsCard ws={ws} />
      <Card title={t("consentTitle")}>
        <div className={styles.switchRow}>
          <Switch checked={s.requireConsentOnFirstLogin} label={t("consent")} onChange={(v) => void save({ requireConsentOnFirstLogin: v })} />
          <div><b>{t("consent")}</b></div>
        </div>
      </Card>
      <DeleteWorkspace ws={ws} />
    </>
  );
}

function ExportRow({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.data");
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "exports");
  const exports = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: WorkspaceExport[] }>(`${wsPath(ws)}/exports`),
    // งาน Export ทำในคิว · ถามซ้ำจนเสร็จ
    refetchInterval: (q) => (q.state.data?.items.some((e) => e.status === "queued" || e.status === "running") ? 5000 : false),
  });
  const latest = exports.data?.items[0];
  async function request() {
    try {
      await api.post(`${wsPath(ws)}/exports`);
      toast({ message: t("exportQueued") });
      await cache.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const busy = latest?.status === "queued" || latest?.status === "running";
  return (
    <div className={styles.dz}>
      <div>
        <b>{t("export")}</b>
        <div className={styles.muted}>
          {!latest ? t("exportNever") : t("exportLatest", { at: when(latest.createdAt), status: t(`exportStatus_${latest.status}`), size: formatBytes(latest.sizeBytes) })}
        </div>
      </div>
      <div className={styles.chips}>
        {latest?.downloadUrl && <a className="button button-secondary" href={latest.downloadUrl}>{t("download")}</a>}
        <Button disabled={busy} onClick={() => void request()}>{busy ? t("exporting") : t("exportStart")}</Button>
      </div>
    </div>
  );
}

const REQ_TONE: Record<DataRequest["status"], string> = { pending: "warn", in_progress: "warn", completed: "ok", rejected: "neu" };

function DataRequestsCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.data");
  const { me } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "data-requests");
  const requests = useQuery({ queryKey: key, queryFn: () => api.get<{ items: DataRequest[] }>(`${wsPath(ws)}/data-requests`) });
  const [handling, setHandling] = useState<DataRequest | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [type, setType] = useState<"erase" | "export">("export");
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      toast({ message });
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const base = `${wsPath(ws)}/data-requests`;
  return (
    <Card title={t("pdpa")} actions={<Button onClick={() => setAdding(true)}>{t("addRequest")}</Button>}>
      {requests.error ? (
        <ErrorState error={requests.error} retry={() => void requests.refetch()} />
      ) : !requests.data ? (
        <LoadingState />
      ) : requests.data.items.length === 0 ? (
        <span className={styles.muted}>{t("noRequests")}</span>
      ) : (
        requests.data.items.map((r) => (
          <div key={r.id} className={styles.row}>
            <span className={`${styles.pill} ${styles[r.overdue ? "bad" : REQ_TONE[r.status]]}`}>{t(`req_${r.status}`)}</span>
            <span className={styles.grow}>
              <b>{t(r.requestType === "erase" ? "typeErase" : "typeExport")}</b> · {r.requesterEmail}
              <div className={styles.muted}>
                {r.status === "completed" && r.completedAt ? t("completedAt", { date: formatDate(r.completedAt, me.yearFormat) }) : t("filedDue", { filed: formatDate(r.createdAt, me.yearFormat), due: formatDate(r.dueDate, me.yearFormat, true) })}
              </div>
            </span>
            {r.status === "completed" && r.requestType === "export" && <a className="button button-secondary button-small" href={`/api/v1${base}/${r.id}/result`}>{t("download")}</a>}
            {r.status !== "completed" && r.status !== "rejected" && <Button size="small" variant="primary" onClick={() => { setConfirmEmail(""); setHandling(r); }}>{t("handle")}</Button>}
          </div>
        ))
      )}
      <Dialog open={!!handling} onOpenChange={(v) => !v && setHandling(null)} title={handling ? t(handling.requestType === "erase" ? "handleErase" : "handleExport", { email: handling.requesterEmail }) : ""} description={handling?.requestType === "erase" ? t("eraseHint") : t("exportHint")}>
        {handling && (
          <div className={styles.dialogForm}>
            {handling.requestType === "erase" && <Input label={t("confirmEmail")} value={confirmEmail} autoComplete="off" onChange={(e) => setConfirmEmail(e.target.value)} />}
            <div className="dialog-actions">
              {handling.status === "pending" && <Button disabled={busy} onClick={() => void run(() => patch(`${base}/${handling.id}`, { status: "in_progress" }), t("markedInProgress")).then((ok) => ok && setHandling(null))}>{t("markInProgress")}</Button>}
              <Button disabled={busy} onClick={() => void run(() => patch(`${base}/${handling.id}`, { status: "rejected" }), t("rejected")).then((ok) => ok && setHandling(null))}>{t("reject")}</Button>
              <Button
                variant={handling.requestType === "erase" ? "danger" : "primary"}
                disabled={busy || (handling.requestType === "erase" && confirmEmail.trim().toLowerCase() !== handling.requesterEmail.toLowerCase())}
                onClick={() => void run(() => api.post(`${base}/${handling.id}/complete`, handling.requestType === "erase" ? { confirmEmail: confirmEmail.trim() } : {}), t("completed")).then((ok) => ok && setHandling(null))}
              >
                {t("complete")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog open={adding} onOpenChange={setAdding} title={t("addRequest")}>
        <div className={styles.dialogForm}>
          <Input label={t("requester")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Select label={t("requestType")} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="export">{t("typeExport")}</option>
            <option value="erase">{t("typeErase")}</option>
          </Select>
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={busy || !email.includes("@")} onClick={() => void run(() => api.post(base, { requesterEmail: email.trim(), requestType: type }), t("requestAdded")).then((ok) => { if (ok) { setAdding(false); setEmail(""); } })}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function DeleteWorkspace({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.data");
  const { workspace } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      const r = await api.delete<{ restorableUntil: string }>(wsPath(ws), { body: { confirmSlug: confirm.trim() } });
      toast({ message: t("deletedToast", { date: formatDate(r.restorableUntil, "BE", true) }) });
      router.push("/");
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`${styles.dz} ${styles.danger}`}>
      <div>
        <b>{t("deleteTitle")}</b>
        <div className={styles.muted}>{t("deleteHint")}</div>
        {workspace.role !== "owner" && <div className={styles.muted}>{t("ownerOnly")}</div>}
      </div>
      {workspace.role === "owner" && <Button variant="danger" onClick={() => { setConfirm(""); setOpen(true); }}>{t("delete")}</Button>}
      <Dialog open={open} onOpenChange={setOpen} title={t("deleteTitle")} description={t("deleteHint")}>
        <div className={styles.dialogForm}>
          <Input label={t("confirmSlug", { slug: workspace.slug })} value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} className={styles.mono} />
          <div className="dialog-actions">
            <Button onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button variant="danger" disabled={busy || confirm.trim().toLowerCase() !== workspace.slug.toLowerCase()} onClick={() => void remove()}>{t("deleteConfirm")}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
