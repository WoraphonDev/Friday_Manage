"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Modal, Notice } from "@/components/kit";
import { useReauth } from "@/components/dialogs";
import { Button, InlineError, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../bugs.module.css";
import { BRIDGE_KEY, type Mapping, PRIORITIES, type Priority, type Settings, SEVERITIES } from "./types";

interface TestResult {
  ok: boolean;
  checks: {
    key: "token" | "project" | "released" | "label";
    ok: boolean;
    message: string;
  }[];
}

/** T11 · ตั้งค่าการเชื่อมต่อกับ Friday Manage ของทีมพัฒนา · Owner / วิศวกร · เปลี่ยน token / secret ต้องแตะ Security key (G4) */
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const t = useTranslations("bugs.t11");
  const tp = useTranslations("bugs.priority");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const edit = settings.canEdit;
  const [ws, setWs] = useState(settings.workspaceSlug ?? "");
  const [project, setProject] = useState(settings.projectKey ?? "");
  const [base, setBase] = useState(settings.apiBaseUrl ?? "http://api:3001");
  const [token, setToken] = useState("");
  const [expires, setExpires] = useState(settings.tokenExpiresAt ? settings.tokenExpiresAt.slice(0, 10) : "");
  const [secret, setSecret] = useState("");
  const [mapping, setMapping] = useState<Mapping>(settings.mapping);
  const [result, setResult] = useState<TestResult | null>(null);

  const save = useMutation({
    mutationFn: () =>
      run(
        () =>
          api.put<Settings>("/dev-bridge/settings", {
            apiBaseUrl: base.trim(),
            workspaceSlug: ws.trim(),
            projectKey: project.trim().toUpperCase(),
            ...(token.trim() ? { token: token.trim() } : {}),
            tokenExpiresAt: expires || null,
            ...(secret.trim() ? { webhookSecret: secret.trim() } : {}),
            mapping,
          }),
        t("title"),
      ),
    onSuccess: () => (toast({ message: t("saved") }), void cache.invalidateQueries({ queryKey: BRIDGE_KEY }), onClose()),
  });
  const test = useMutation({
    mutationFn: () => api.post<TestResult>("/dev-bridge/settings/test"),
    onSuccess: (r) => (setResult(r), void cache.invalidateQueries({ queryKey: BRIDGE_KEY })),
  });
  const ok = ws.trim().length >= 2 && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(project.trim()) && /^https?:\/\/\S+$/.test(base.trim()) && (settings.tokenHint || token.trim().length >= 10);

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} className="dialog-wide" title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), edit && ok && save.mutate())}>
        {!edit && <Notice tone="info" title={t("readOnly")} />}
        <div className={styles.pair}>
          <Input label={`${t("workspace")} *`} value={ws} readOnly={!edit} hint={t("workspaceHint")} onChange={(e) => setWs(e.target.value)} />
          <Input label={`${t("project")} *`} value={project} readOnly={!edit} hint={t("projectHint")} onChange={(e) => setProject(e.target.value)} />
        </div>
        <Input label={`${t("apiBaseUrl")} *`} className="mono" value={base} readOnly={!edit} hint={t("apiBaseUrlHint")} onChange={(e) => setBase(e.target.value)} />
        <div className={styles.pair}>
          <Input
            label={`${t("token")} *`}
            type="password"
            autoComplete="off"
            className="mono"
            value={token}
            readOnly={!edit}
            placeholder={settings.tokenHint ? t("tokenKeep", { hint: settings.tokenHint }) : "fm_tok_…"}
            hint={t("tokenHint")}
            onChange={(e) => setToken(e.target.value)}
          />
          <Input label={t("tokenExpires")} type="date" value={expires} readOnly={!edit} onChange={(e) => setExpires(e.target.value)} />
        </div>
        <Input
          label={t("secret")}
          type="password"
          autoComplete="off"
          className="mono"
          value={secret}
          readOnly={!edit}
          placeholder={settings.hasWebhookSecret ? t("secretKeep") : ""}
          hint={t("secretHint", { path: settings.webhookPath })}
          onChange={(e) => setSecret(e.target.value)}
        />
        <fieldset className={styles.mapping}>
          <legend className="field-label">{t("mapping")}</legend>
          {SEVERITIES.map((s) => (
            <div key={s} className={styles.mapRow}>
              <span className="muted">{s}</span>
              <ArrowRight size={14} aria-hidden="true" />
              <select
                className="input select-inline"
                aria-label={t("severityTo", { s })}
                value={mapping.severityPriority[s]}
                disabled={!edit}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    severityPriority: {
                      ...mapping.severityPriority,
                      [s]: e.target.value as Priority,
                    },
                  })
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {tp(p)}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className={styles.mapRow}>
            <Input label={t("releasedStatus")} value={mapping.releasedStatus} readOnly={!edit} hint={t("releasedNote")} onChange={(e) => setMapping({ ...mapping, releasedStatus: e.target.value })} />
            <Input label={t("label")} value={mapping.label} readOnly={!edit} onChange={(e) => setMapping({ ...mapping, label: e.target.value })} />
          </div>
          <p className="muted small">{t("resolutionNote")}</p>
        </fieldset>
        {result && (
          <Notice tone={result.ok ? "ok" : "bad"} title={result.ok ? t("testOk") : t("testFail")}>
            <ul className={styles.checks}>
              {result.checks.map((c) => (
                <li key={c.key}>
                  {c.ok ? <Check size={14} aria-label="ok" /> : <X size={14} aria-label="fail" />} <b>{t(`check.${c.key}`)}</b> · {c.message}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <InlineError error={save.error ?? test.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          {edit && (
            <>
              <Button disabled={!settings.configured || test.isPending} title={t("testNote")} onClick={() => test.mutate()}>
                {t("test")}
              </Button>
              <Button type="submit" variant="primary" disabled={!ok || save.isPending}>
                {t("save")}
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
