"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ConfirmDialog, Dialog, ErrorState, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Card, patch, Switch, usePatchSettings, useSettings } from "./shared";
import {
  adminKey, errorText, formatBytes, WEBHOOK_FORMATS, wsPath,
  type AdminOverview, type ApiToken, type EmailConfig, type GitIntegrations, type LineConfig, type Webhook, type WebhookFormat,
} from "./types";
import styles from "./admin.module.css";

/** ค่าลับที่ระบบสร้างให้แสดงครั้งเดียว · ปิดแล้วล้างจาก state ทันที (ไม่เก็บใน cache) */
function SecretOnce({ title, hint, value, onClose }: { title: string; hint: string; value: string | null; onClose: () => void }) {
  const t = useTranslations("admin-automation.admin");
  const toast = useToast();
  return (
    <Dialog open={!!value} onOpenChange={(v) => !v && onClose()} title={title} description={hint}>
      <div className={styles.dialogForm}>
        <div className={styles.secret}>
          <code aria-label={title}>{value}</code>
        </div>
        <div className="dialog-actions">
          <Button onClick={() => void navigator.clipboard?.writeText(value ?? "").then(() => toast({ message: t("copied") }), () => undefined)}>{t("copy")}</Button>
          <Button variant="primary" onClick={onClose}>{t("done")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ช่องทางแจ้งเตือน
// ---------------------------------------------------------------------------

export function NotifySection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.notify");
  const settings = useSettings(ws);
  const save = usePatchSettings(ws);
  const safe = settings.data?.safeMode ?? true;
  return (
    <>
      <Card title={t("policy")} actions={<Link className="button button-secondary" href={`${wsPath(ws)}/admin/notify-templates`}>{t("preview")}</Link>}>
        {settings.error ? (
          <ErrorState error={settings.error} retry={() => void settings.refetch()} />
        ) : !settings.data ? (
          <LoadingState />
        ) : (
          <div className={styles.switchRow}>
            <Switch checked={safe} label={t("safe")} onChange={(v) => void save({ safeMode: v })} />
            <div>
              <b>{t("safe")}</b> <span className={`${styles.pill} ${safe ? styles.ok : styles.neu}`}>{safe ? t("on") : t("off")}</span>
              <div className={styles.muted}>{t("safeHint")}</div>
            </div>
          </div>
        )}
        <span className={styles.muted}>{t("policyHint")}</span>
      </Card>
      <LineCard ws={ws} />
      <EmailCard ws={ws} />
      <WebhooksCard ws={ws} />
    </>
  );
}

function LineCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.line");
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "line");
  const base = `${wsPath(ws)}/channels`;
  const line = useQuery({ queryKey: key, queryFn: () => api.get<LineConfig>(`${base}/line-oa`) });
  const groups = useQuery({ queryKey: adminKey(ws, "line-groups"), queryFn: () => api.get<{ items: { id: string; name: string }[] }>(`${base}/line-groups`), enabled: !!line.data?.configured });
  const [form, setForm] = useState<{ channelId: string; channelSecret: string; accessToken: string; fallbackToEmail: boolean; batchDigestMinutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const c = line.data?.config;
  const f = form ?? { channelId: c?.channelId ?? "", channelSecret: "", accessToken: "", fallbackToEmail: c?.fallbackToEmail ?? true, batchDigestMinutes: c?.batchDigestMinutes ?? 5 };
  const set = (patchValue: Partial<typeof f>) => setForm({ ...f, ...patchValue });
  async function save() {
    setBusy(true);
    try {
      // ช่องลับเว้นว่าง = ใช้ค่าเดิม (API ตอบกลับแค่ 4 ตัวท้าย)
      const next = await api.put<LineConfig>(`${base}/line-oa`, {
        channelId: f.channelId.trim(),
        ...(f.channelSecret.trim() ? { channelSecret: f.channelSecret.trim() } : {}),
        ...(f.accessToken.trim() ? { accessToken: f.accessToken.trim() } : {}),
        fallbackToEmail: f.fallbackToEmail,
        batchDigestMinutes: f.batchDigestMinutes,
      });
      cache.setQueryData(key, next);
      setForm(null);
      toast({ message: t("saved") });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    try {
      const r = await api.post<{ botName: string | null }>(`${base}/line-oa/test`);
      toast({ message: t("testOk", { name: r.botName ?? "LINE OA" }) });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  return (
    <Card title={t("title")} actions={line.data && <span className={`${styles.pill} ${line.data.configured ? styles.ok : styles.neu}`}>{line.data.configured ? t("connected") : t("notConnected")}</span>} label={t("title")}>
      <span className={styles.muted}>{t("hint")}</span>
      {line.error ? (
        <ErrorState error={line.error} retry={() => void line.refetch()} />
      ) : !line.data ? (
        <LoadingState />
      ) : (
        <>
          <div className={styles.grid}>
            <Input label={t("channelId")} value={f.channelId} onChange={(e) => set({ channelId: e.target.value })} className={styles.mono} />
            <Input label={t("secret")} type="password" autoComplete="off" value={f.channelSecret} placeholder={c?.channelSecretLast4 ? `•••• ${c.channelSecretLast4}` : ""} hint={c ? t("keepHint") : undefined} onChange={(e) => set({ channelSecret: e.target.value })} />
            <Input label={t("token")} type="password" autoComplete="off" value={f.accessToken} placeholder={c?.accessTokenLast4 ? `•••• ${c.accessTokenLast4}` : ""} hint={c ? t("keepHint") : undefined} onChange={(e) => set({ accessToken: e.target.value })} />
          </div>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("webhookUrl")}</span>
            <div className={styles.chips} style={{ flexWrap: "nowrap" }}>
              <input className={`${styles.in} ${styles.mono}`} readOnly value={line.data.webhookUrl} aria-label={t("webhookUrl")} />
              <Button onClick={() => void navigator.clipboard?.writeText(line.data!.webhookUrl).then(() => toast({ message: t("copied") }), () => undefined)}>{t("copy")}</Button>
            </div>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={f.fallbackToEmail} onChange={(e) => set({ fallbackToEmail: e.target.checked })} />
            {t("fallback")}
          </label>
          <Select label={t("digest")} value={String(f.batchDigestMinutes)} onChange={(e) => set({ batchDigestMinutes: Number(e.target.value) })}>
            {[...new Set([5, 15, 30, 60, f.batchDigestMinutes])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{t("minutes", { n })}</option>)}
          </Select>
          {line.data.configured && <span className={styles.muted}>{t("groups", { n: groups.data?.items.length ?? 0 })}</span>}
          <div className={styles.actions}>
            {line.data.configured && <Button onClick={() => void test()}>{t("test")}</Button>}
            <Button variant="primary" disabled={busy || !f.channelId.trim() || (!c && (!f.channelSecret.trim() || !f.accessToken.trim()))} onClick={() => void save()}>{t("save")}</Button>
          </div>
        </>
      )}
    </Card>
  );
}

function EmailCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.email");
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "email");
  const base = `${wsPath(ws)}/channels/email`;
  const email = useQuery({ queryKey: key, queryFn: () => api.get<EmailConfig>(base) });
  const [form, setForm] = useState<{ fromName: string; fromEmail: string; replyTo: string } | null>(null);
  const c = email.data?.config;
  const f = form ?? { fromName: c?.fromName ?? "", fromEmail: c?.fromEmail ?? "", replyTo: c?.replyTo ?? "" };
  async function call(fn: () => Promise<EmailConfig | unknown>, message: string, update = true) {
    try {
      const r = await fn();
      if (update) cache.setQueryData(key, r);
      setForm(null);
      toast({ message });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const status = !email.data?.configured ? "notSet" : c?.verifiedAt ? "verified" : "pending";
  return (
    <Card title={t("title")} actions={email.data && <span className={`${styles.pill} ${status === "verified" ? styles.ok : status === "pending" ? styles.warn : styles.neu}`}>{t(`status_${status}`)}</span>} label={t("title")}>
      <span className={styles.muted}>{t("hint")}</span>
      {email.error ? (
        <ErrorState error={email.error} retry={() => void email.refetch()} />
      ) : !email.data ? (
        <LoadingState />
      ) : (
        <>
          <div className={styles.grid}>
            <Input label={t("fromName")} value={f.fromName} onChange={(e) => setForm({ ...f, fromName: e.target.value })} />
            <Input label={t("fromEmail")} type="email" value={f.fromEmail} onChange={(e) => setForm({ ...f, fromEmail: e.target.value })} />
            <Input label={t("replyTo")} type="email" value={f.replyTo} onChange={(e) => setForm({ ...f, replyTo: e.target.value })} />
          </div>
          {c && (
            <div>
              <b className={styles.lb}>{t("dns")}</b>
              {(["spf", "dkim", "dmarc"] as const).map((k) => (
                <div key={k} className={styles.row}>
                  <span style={{ width: 70 }}><b>{k.toUpperCase()}</b></span>
                  <span className={`${styles.grow} ${styles.muted}`}>{t(`dns_${k}`)}</span>
                  <span className={`${styles.pill} ${c.dns[k] ? styles.ok : k === "dmarc" ? styles.neu : styles.bad}`}>{c.dns[k] ? t("pass") : t("missing")}</span>
                </div>
              ))}
            </div>
          )}
          {status === "pending" && <span className={styles.muted}>{t("pendingHint")}</span>}
          <div className={styles.actions}>
            {c && <Button onClick={() => void call(() => api.post(`${base}/verify-dns`), t("checked"))}>{t("verify")}</Button>}
            {c && <Button onClick={() => void call(() => api.post<{ to: string }>(`${base}/test`), t("testSent"), false)}>{t("test")}</Button>}
            <Button
              variant="primary"
              disabled={!form || !f.fromName.trim() || !f.fromEmail.includes("@")}
              onClick={() => void call(() => api.put(base, { fromName: f.fromName.trim(), fromEmail: f.fromEmail.trim(), replyTo: f.replyTo.trim() || null }), t("saved"))}
            >
              {t("save")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function WebhooksCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.webhook");
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "webhooks");
  const base = `${wsPath(ws)}/channels/webhooks`;
  const hooks = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Webhook[] }>(base) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<WebhookFormat>("discord");
  const [url, setUrl] = useState("");
  const [generate, setGenerate] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  async function call(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      toast({ message });
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  async function create() {
    setBusy(true);
    try {
      const created = await api.post<Webhook>(base, { name: name.trim(), format, url: url.trim(), generateSecret: format === "json" && generate });
      setAdding(false);
      setName("");
      setUrl("");
      // signing secret แสดงครั้งเดียวจากคำตอบของ POST
      if (created.signingSecret) setSecret(created.signingSecret);
      toast({ message: t("created", { name: created.name }) });
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={t("title")} actions={<Button variant="primary" onClick={() => setAdding(true)}>{t("add")}</Button>} label={t("title")}>
      <span className={styles.muted}>{t("hint")}</span>
      {hooks.error ? (
        <ErrorState error={hooks.error} retry={() => void hooks.refetch()} />
      ) : !hooks.data ? (
        <LoadingState />
      ) : hooks.data.items.length === 0 ? (
        <span className={styles.muted}>{t("empty")}</span>
      ) : (
        <div>
          {hooks.data.items.map((h) => {
            const failing = h.consecutiveFailures > 0;
            return (
              <div key={h.id} className={styles.row}>
                <span className={`${styles.pill} ${styles.neu}`}>{t(`format_${h.format}`)}</span>
                <span className={styles.grow}>
                  <b>{h.name}</b>
                  <div className={`${styles.muted} ${styles.mono}`}>{h.urlLast4 ? `…${h.urlLast4}` : "—"}{h.signed ? ` · ${t("signed")}` : ""}</div>
                  <div className={styles.muted}>{h.usedBy.length ? h.usedBy.map((u) => `${u.projectKey} · ${u.eventType}`).join(", ") : t("unused")}</div>
                </span>
                <span className={`${styles.pill} ${h.status === "paused" ? styles.bad : failing ? styles.warn : styles.ok}`}>{h.status === "paused" ? t("paused") : failing ? t("failing", { n: h.consecutiveFailures }) : t("ok")}</span>
                <Button size="small" onClick={() => void call(() => api.post(`${base}/${h.id}/test`), t("tested"))}>{t("test")}</Button>
                <Button size="small" onClick={() => void call(() => patch(`${base}/${h.id}`, { status: h.status === "paused" ? "active" : "paused" }), h.status === "paused" ? t("resumed") : t("pausedToast"))}>{h.status === "paused" ? t("resume") : t("pause")}</Button>
                <Button size="small" variant="ghost" aria-label={t("remove", { name: h.name })} onClick={() => setRemoving(h)}>×</Button>
              </div>
            );
          })}
        </div>
      )}
      <Dialog open={adding} onOpenChange={setAdding} title={t("add")}>
        <div className={styles.dialogForm}>
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Select label={t("format")} value={format} onChange={(e) => setFormat(e.target.value as WebhookFormat)}>
            {WEBHOOK_FORMATS.map((f) => <option key={f} value={f}>{t(`format_${f}`)}</option>)}
          </Select>
          <Input label={t("url")} type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          {format === "json" && (
            <label className={styles.check}>
              <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} />
              {t("generateSecret")}
            </label>
          )}
          <span className={styles.muted}>{t("retry")}</span>
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={busy || !name.trim() || !/^https?:\/\/.+/.test(url.trim())} onClick={() => void create()}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>
      <SecretOnce title={t("secretTitle")} hint={t("secretHint")} value={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={t("removeConfirm", { name: removing?.name ?? "" })}
        description={t("removeHint")}
        confirmLabel={t("delete")}
        successMessage={t("removed")}
        onConfirm={async () => {
          await api.delete(`${base}/${removing!.id}`);
          await refresh();
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export function IntegrationsSection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.integ");
  const toast = useToast();
  const git = useQuery({ queryKey: adminKey(ws, "git"), queryFn: () => api.get<GitIntegrations>(`${wsPath(ws)}/integrations/git`) });
  async function install() {
    try {
      const r = await api.get<{ url: string }>(`${wsPath(ws)}/integrations/git/install-url`);
      window.location.assign(r.url);
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const repos = git.data?.items.reduce((n, i) => n + i.repositories.length, 0) ?? 0;
  return (
    <>
      <Card title={t("title")} label={t("title")}>
        <span className={styles.muted}>{t("hint")}</span>
        <div className={styles.row}>
          <span className={styles.grow}>
            <b>{t("github")}</b>
            <div className={styles.muted}>
              {git.error ? errorText(git.error, t("failed")) : !git.data ? t("loading") : git.data.items.length ? git.data.items.map((i) => i.accountName).join(", ") + ` · ${t("repos", { n: repos })}` : t("githubHint")}
            </div>
          </span>
          {git.data && (git.data.items.length ? <span className={`${styles.pill} ${styles.ok}`}>{t("connected")}</span> : git.data.configured ? <Button onClick={() => void install()}>{t("connect")}</Button> : <span className={`${styles.pill} ${styles.neu}`}>{t("notConfigured")}</span>)}
        </div>
        <div className={styles.row}>
          <span className={styles.grow}><b>{t("gitlab")}</b><div className={styles.muted}>{t("gitlabHint")}</div></span>
          <span className={`${styles.pill} ${styles.neu}`}>{t("later")}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.grow}><b>{t("hr")}</b><div className={styles.muted}>{t("hrHint")}</div></span>
          <span className={`${styles.pill} ${styles.neu}`}>{t("later")}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.grow}><b>{t("channels")}</b><div className={styles.muted}>{t("channelsHint")}</div></span>
          <Link className="button button-secondary button-small" href={`${wsPath(ws)}/admin/notify`}>{t("open")}</Link>
        </div>
      </Card>
      <ApiTokensCard ws={ws} />
    </>
  );
}

function ApiTokensCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.tokens");
  const { me } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "tokens");
  const base = `${wsPath(ws)}/api-tokens`;
  const tokens = useQuery({ queryKey: key, queryFn: () => api.get<{ items: ApiToken[] }>(base) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  async function create() {
    try {
      const created = await api.post<ApiToken>(base, { name: name.trim(), scopes: write ? ["read", "write"] : ["read"] });
      setOpen(false);
      setName("");
      setWrite(false);
      setSecret(created.token ?? null);
      await cache.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const active = tokens.data?.items.filter((x) => !x.revoked) ?? [];
  return (
    <Card title={t("title")} actions={<Button variant="primary" onClick={() => setOpen(true)}>{t("create")}</Button>} label={t("title")}>
      <span className={styles.muted}>{t("hint")}</span>
      {tokens.error ? (
        <ErrorState error={tokens.error} retry={() => void tokens.refetch()} />
      ) : !tokens.data ? (
        <LoadingState />
      ) : active.length === 0 ? (
        <span className={styles.muted}>{t("empty")}</span>
      ) : (
        <div>
          {active.map((x) => (
            <div key={x.id} className={styles.row}>
              <span className={styles.grow}>
                <b>{x.name}</b>
                <div className={styles.muted}>{t("meta", { by: x.createdBy?.displayName ?? "—", created: formatDate(x.createdAt, me.yearFormat), used: x.lastUsedAt ? formatDate(x.lastUsedAt, me.yearFormat) : t("neverUsed") })}</div>
              </span>
              {x.scopes.map((s) => <span key={s} className={`${styles.pill} ${s === "write" ? styles.warn : styles.neu}`}>{t(`scope_${s}`)}</span>)}
              <Button size="small" variant="ghost" onClick={() => setRevoking(x)}>{t("revoke")}</Button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title={t("create")}>
        <div className={styles.dialogForm}>
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <label className={styles.check}>
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
            {t("allowWrite")}
          </label>
          <div className="dialog-actions">
            <Button onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>
      <SecretOnce title={t("secretTitle")} hint={t("secretHint")} value={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(v) => !v && setRevoking(null)}
        title={t("revokeConfirm", { name: revoking?.name ?? "" })}
        description={t("revokeHint")}
        confirmLabel={t("revoke")}
        successMessage={t("revoked")}
        onConfirm={async () => {
          await api.delete(`${base}/${revoking!.id}`);
          await cache.invalidateQueries({ queryKey: key });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// แพ็กเกจ & Billing (หน้าเต็มอยู่ที่ /billing ของ W19)
// ---------------------------------------------------------------------------

export function BillingSection({ ws, data }: { ws: string; data: AdminOverview }) {
  const t = useTranslations("admin-automation.admin.bill");
  const { me } = useWorkspace();
  const trial = data.plan.status === "trialing";
  return (
    <Card title={t("title")} actions={<Link className="button button-primary" href={`${wsPath(ws)}/billing`}>{t("open")}</Link>}>
      <div className={styles.kpis}>
        <div className={styles.kp}>
          <span className={styles.muted}>{t("plan")}</span>
          <b>{data.plan.name}</b>
          <span className={`${styles.pill} ${trial ? styles.warn : styles.ok}`}>{trial ? t("trial", { date: data.plan.trialEndsAt ? formatDate(data.plan.trialEndsAt, me.yearFormat, true) : "—" }) : t(`status_${data.plan.status === "active" ? "active" : "other"}`)}</span>
        </div>
        <div className={styles.kp}><span className={styles.muted}>{t("seats")}</span><b>{data.users.seatLimit === null ? data.users.active : `${data.users.active} / ${data.users.seatLimit}`}</b><span className={styles.muted}>{t("guestsFree")}</span></div>
        <div className={styles.kp}><span className={styles.muted}>{t("storage")}</span><b>{formatBytes(data.storage.usedBytes)}</b><span className={styles.muted}>{data.storage.limitBytes === null ? "" : `/ ${formatBytes(data.storage.limitBytes)}`}</span></div>
      </div>
      <span className={styles.muted}>{t("hint")}</span>
    </Card>
  );
}

