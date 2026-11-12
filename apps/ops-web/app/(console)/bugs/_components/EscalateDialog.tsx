"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Modal, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import styles from "../bugs.module.css";
import { IssueSearch } from "./IssuePicker";
import { BRIDGE_KEY, type FmIssue, PRIORITIES, type Priority, type Settings, SEVERITIES, type Severity } from "./types";

/**
 * T3 (ปรับ O36) · ส่งต่อทีมพัฒนา: สร้างงาน Bug ใหม่ในโปรเจกต์ FM หรือผูกกับงานเดิม (T7) · เตือนงานที่อาจซ้ำจากหัวข้อ Ticket
 * ยังไม่ตั้งค่าการเชื่อมต่อ (หรือ ops-api ตอบ bridge_not_configured) = ส่งต่อแบบเดิมของเฟส 1 (pending_dev + บันทึกภายใน)
 */
export function EscalateDialog({ ticket, onClose }: { ticket: { id: string; number: number; subject: string }; onClose: () => void }) {
  const t = useTranslations("bugs.t3");
  const ts = useTranslations("bugs");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: [...BRIDGE_KEY, "settings"],
    queryFn: () => api.get<Settings>("/dev-bridge/settings"),
  });
  const configured = !!settings.data?.configured;
  const similar = useQuery({
    queryKey: [...BRIDGE_KEY, "similar", ticket.subject],
    queryFn: () => api.get<{ items: FmIssue[] }>(`/dev-bridge/issues?q=${encodeURIComponent(ticket.subject)}&similar=1`),
    enabled: configured,
    retry: false,
  });
  const [mode, setMode] = useState<"create" | "link">("create");
  const [issueKey, setIssueKey] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity>("S2");
  const [priority, setPriority] = useState<Priority | null>(null);
  const [title, setTitle] = useState(ticket.subject);
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [affected, setAffected] = useState("");
  const [requestId, setRequestId] = useState("");
  const [notify, setNotify] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const mapping = settings.data?.mapping;
  useEffect(() => {
    // ตั้งค่าโหลดไม่ได้ (เช่น ops-api เก่า) = ส่งต่อแบบเดิม
    if (settings.error) setLegacy(true);
    else if (settings.data && !settings.data.configured) setLegacy(true);
  }, [settings.data, settings.error]);
  const autoPriority = mapping?.severityPriority[severity] ?? "high";
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);

  const old = () =>
    api.post(`/tickets/${ticket.id}/escalate`, {
      severity,
      steps: steps.trim(),
      affected: opt(affected),
      requestId: opt(requestId),
      notifyCustomer: notify,
    });
  const m = useMutation({
    mutationFn: async (): Promise<{
      key: string | null;
      fallback?: boolean;
    }> => {
      if (legacy) return old().then(() => ({ key: null }));
      try {
        const r = await api.post<{ link: { issueKey: string } }>(`/dev-bridge/tickets/${ticket.id}/escalate`, {
          mode,
          severity,
          steps: steps.trim(),
          notifyCustomer: notify,
          ...(mode === "create" ? { title: title.trim(), ...(priority ? { priority } : {}) } : { issueKey }),
          ...(opt(expected) ? { expected: opt(expected) } : {}),
          ...(opt(affected) ? { affected: opt(affected) } : {}),
          ...(opt(requestId) ? { requestId: opt(requestId) } : {}),
        });
        return { key: r.link.issueKey };
      } catch (e) {
        // ระหว่างเปิดกล่องมีคนล้างการตั้งค่า: ใช้วิธีเดิม Ticket ยังไปถึงทีม
        if (e instanceof ApiError && e.code === "bridge_not_configured") {
          setLegacy(true);
          await old();
          return { key: null, fallback: true };
        }
        throw e;
      }
    },
    onSuccess: ({ key, fallback }) => {
      toast({
        message: key ? t("done", { key }) : fallback ? t("fallback") : t("doneLegacy"),
      });
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  const sim = similar.data?.items[0];
  const ready = steps.trim().length >= 10 && (legacy || (mode === "create" ? title.trim().length >= 5 : !!issueKey));

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { n: ticket.number })} description={t("desc")}>
      {settings.isPending ? (
        <TableSkeleton rows={4} cols={1} />
      ) : (
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ready && m.mutate())}>
          {legacy ? (
            <Notice tone="info">{t("legacy")}</Notice>
          ) : (
            <>
              <fieldset className={styles.radios}>
                <legend className="sr-only">{t("mode")}</legend>
                {(["create", "link"] as const).map((v) => (
                  <label key={v} className={`${styles.radioCard} ${mode === v ? styles.radioOn : ""}`}>
                    <input type="radio" name="t3-mode" checked={mode === v} onChange={() => setMode(v)} />
                    <span>
                      <b>{v === "create" ? t("create") : t("link")}</b>
                      <span className="muted small">
                        {v === "create"
                          ? t("createNote", {
                              ws: settings.data?.workspaceSlug ?? "—",
                              project: settings.data?.projectKey ?? "—",
                              label: mapping?.label ?? "from-support",
                            })
                          : t("linkNote")}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {sim && issueKey !== sim.key && (
                <Notice
                  tone="warn"
                  action={
                    <Button size="small" onClick={() => (setMode("link"), setIssueKey(sim.key))}>
                      {t("useSimilar")}
                    </Button>
                  }
                >
                  {t("similar", {
                    key: sim.key,
                    title: sim.title,
                    n: sim.linkedTickets,
                  })}
                </Notice>
              )}
              {mode === "link" && (
                <>
                  <IssueSearch selected={issueKey} onSelect={(i) => setIssueKey(i.key)} />
                  <p className="small">{issueKey ? t("picked", { key: issueKey }) : <span className="muted">{t("pickFirst")}</span>}</p>
                </>
              )}
            </>
          )}
          <div className={styles.pair}>
            <Select label={`${t("severity")} *`} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {ts(`sev.${s}`)}
                </option>
              ))}
            </Select>
            {!legacy && mode === "create" && (
              <Select label={t("priority")} value={priority ?? ""} onChange={(e) => setPriority((e.target.value || null) as Priority | null)}>
                <option value="">
                  {ts("priority.fromMapping", {
                    p: ts(`priority.${autoPriority}`),
                  })}
                </option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {ts(`priority.${p}`)}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {!legacy && mode === "create" && <Input label={`${t("issueTitle")} *`} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />}
          <Textarea label={`${t("steps")} *`} rows={3} value={steps} onChange={(e) => setSteps(e.target.value)} hint={tc("reasonRequired", { min: 10 })} />
          <div className={styles.pair}>
            {!legacy && <Input label={t("expected")} value={expected} onChange={(e) => setExpected(e.target.value)} />}
            <Input label={t("affected")} placeholder={t("affectedHint")} value={affected} onChange={(e) => setAffected(e.target.value)} />
          </div>
          <Input label={t("requestId")} className="mono" value={requestId} onChange={(e) => setRequestId(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>{t("notifyCustomer")}</span>
          </label>
          <p className={styles.note}>{t("privacy")}</p>
          <InlineError error={m.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{tc("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!ready || m.isPending}>
              {legacy ? t("submitLegacy") : mode === "create" ? t("submitCreate") : t("submitLink")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
