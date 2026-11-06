"use client";

import { useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Forbidden, LoadingState, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { RuleEditor } from "./rule-editor";
import { blankRule, errorText, type FormOptions, type Rule, type RuleList, type RuleShape, type Run, type Template } from "./types";
import styles from "./automation.module.css";

type Tab = "rules" | "tpl" | "log";
const thTime = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const RESULT_TONE: Record<Run["result"], string> = { success: "ok", skipped: "neu", failed: "bad", retried: "warn" };

/** หน้า P2 · Automation ของโปรเจกต์ (`project.automation`) */
export function AutomationPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("admin-automation.automation");
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const href = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const listKey = ["workspace", ws, "project", projectKey, "automations"];
  const projectName = useWorkspace().projects.find((p) => p.key === projectKey)?.name;
  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const allowed = !!perms.data?.permissions.includes("project.automation") && !perms.data.guestViewer;
  const rules = useQuery({ queryKey: listKey, queryFn: () => api.get<RuleList>(`${base}/automations`), enabled: allowed });
  const templates = useQuery({ queryKey: ["automation-templates", ws], queryFn: () => api.get<{ items: Template[] }>(`/w/${encodeURIComponent(ws)}/automation-templates`), enabled: allowed });
  // ตัวเลือกสถานะ / คน / Label · โหลดไม่ได้ = พิมพ์ค่าเอง
  const options = useQuery({ queryKey: ["form-options", ws, projectKey], queryFn: () => api.get<FormOptions>(`${base}/form-options`), enabled: allowed, retry: false });
  const [tab, setTab] = useState<Tab>("rules");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleShape | null>(null);

  const error = perms.error ?? rules.error;
  if ((error instanceof ApiError && error.status === 403) || (perms.data && !allowed)) return <div className={styles.page}><Forbidden /></div>;
  if (error) return <div className={styles.page}><ErrorState error={error} retry={() => { void perms.refetch(); void rules.refetch(); }} /></div>;
  if (!perms.data || !rules.data) return <div className={styles.page}><LoadingState /></div>;

  const list = rules.data.items;
  const current = draft ? null : (list.find((r) => r.id === selected) ?? list[0] ?? null);
  const usage = rules.data.usage;
  const pct = usage.quota ? Math.min(100, Math.round((usage.runsThisMonth / usage.quota) * 100)) : 0;

  async function toggle(rule: Rule) {
    try {
      await api.request(`${base}/automations/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } });
      toast({ message: rule.enabled ? t("disabled", { name: rule.name }) : t("enabled", { name: rule.name }) });
      await cache.invalidateQueries({ queryKey: listKey });
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  function applyTemplate(tpl: Template | null) {
    setDraft(tpl ? { ...tpl.rule, enabled: true } : blankRule());
    setTab("rules");
  }

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <div>
          <div className={styles.muted}>{projectName && <><Link href={href}>{projectName}</Link> / </>}<Link href={`${href}/settings`}>{t("crumbSettings")}</Link> / {t("title")}</div>
          <h1>{t("title")} <span className={`${styles.pill} ${styles.ent}`}>{t("plan")}</span></h1>
          <div className={styles.muted}>{t("description")}</div>
        </div>
        <div className={styles.topRight}>
          <div className={styles.usage}>
            <div className={styles.usageRow}><span className={styles.muted}>{t("usage")}</span><b>{t("usageCount", { n: usage.runsThisMonth, quota: usage.quota })}</b></div>
            <div className={styles.meter} role="progressbar" aria-label={t("usage")} aria-valuenow={usage.runsThisMonth} aria-valuemin={0} aria-valuemax={usage.quota}><span style={{ width: `${pct}%` }} /></div>
          </div>
          <Button variant="primary" onClick={() => setTab("tpl")}>{t("create")}</Button>
        </div>
      </div>

      <div role="tablist" aria-label={t("title")} className={styles.tabs}>
        {(["rules", "tpl", "log"] as const).map((k) => (
          <button key={k} type="button" role="tab" className={styles.tab} aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === "rules" ? t("tabRules", { n: list.length }) : t(k === "tpl" ? "tabTemplates" : "tabLog")}
          </button>
        ))}
      </div>

      {tab === "rules" && (
        <div className={styles.split}>
          <section className={`${styles.card} ${styles.list}`} aria-label={t("listLabel")}>
            {draft && (
              <div className={styles.ruleRow}>
                <button type="button" className={styles.rl} aria-current="true"><b>{draft.name || t("newRule")}</b><div className={styles.muted}>{t("unsaved")}</div></button>
              </div>
            )}
            {list.length === 0 && !draft && <EmptyState title={t("empty")} description={t("emptyHint")} action={<Button onClick={() => setTab("tpl")}>{t("browseTemplates")}</Button>} />}
            {list.map((r) => (
              <div key={r.id} className={styles.ruleRow} style={{ opacity: r.enabled ? 1 : 0.6 }}>
                <button type="button" className={styles.rl} aria-current={current?.id === r.id ? "true" : undefined} onClick={() => { setDraft(null); setSelected(r.id); }}>
                  <span className={styles.grow}>
                    <b>{r.name}</b>
                    <div className={styles.muted}>{r.sentence}</div>
                    <div className={styles.muted}>
                      {r.stats30d?.runs ? t("runs", { n: r.stats30d.runs, at: r.stats30d.lastRunAt ? thTime.format(new Date(r.stats30d.lastRunAt)) : "—" }) : t("neverRan")}
                      {r.createdBy ? ` · ${t("by", { name: r.createdBy.displayName })}` : ""}
                    </div>
                  </span>
                  {!!r.stats30d?.failed && <span className={`${styles.pill} ${styles.bad}`}>{t("errors", { n: r.stats30d.failed })}</span>}
                </button>
                <div className={styles.swWrap}>
                  <button type="button" role="switch" className={styles.switch} aria-checked={r.enabled} aria-label={t("toggle", { name: r.name })} onClick={() => void toggle(r)}><span /></button>
                </div>
              </div>
            ))}
          </section>
          {(draft || current) && (
            <RuleEditor
              key={draft ? `draft-${JSON.stringify(draft)}` : current!.id}
              base={base}
              rule={draft ? null : current}
              initial={draft ?? current!}
              options={options.data ?? null}
              onSaved={async (saved) => {
                setDraft(null);
                setSelected(saved.id);
                await cache.invalidateQueries({ queryKey: listKey });
              }}
              onDeleted={async () => {
                setSelected(null);
                await cache.invalidateQueries({ queryKey: listKey });
              }}
              onCancelDraft={draft ? () => setDraft(null) : undefined}
            />
          )}
        </div>
      )}

      {tab === "tpl" && (
        templates.error ? <ErrorState error={templates.error} retry={() => void templates.refetch()} /> : !templates.data ? <LoadingState /> : (
          <div className={styles.tpls}>
            <div className={styles.tp}>
              <span className={`${styles.pill} ${styles.neu}`}>{t("blankCat")}</span>
              <b>{t("blank")}</b>
              <div className={styles.muted} style={{ flex: 1 }}>{t("blankHint")}</div>
              <div><Button onClick={() => applyTemplate(null)}>{t("startBlank")}</Button></div>
            </div>
            {templates.data.items.map((tpl) => (
              <div key={tpl.id} className={styles.tp}>
                <span className={`${styles.pill} ${styles.neu}`}>{tpl.category}</span>
                <b>{tpl.name}</b>
                <div className={styles.muted} style={{ flex: 1 }}>{tpl.description}</div>
                <div><Button onClick={() => applyTemplate(tpl)} aria-label={t("useTemplateAria", { name: tpl.name })}>{t("useTemplate")}</Button></div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === "log" && <RunsLog base={base} ws={ws} projectKey={projectKey} />}
    </div>
  );
}

function RunsLog({ base, ws, projectKey }: { base: string; ws: string; projectKey: string }) {
  const t = useTranslations("admin-automation.automation");
  const runs = useInfiniteQuery({
    queryKey: ["workspace", ws, "project", projectKey, "automation-runs"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ items: Run[]; nextCursor: string | null }>(`${base}/automations/runs?${new URLSearchParams({ limit: "50", ...(pageParam ? { before: pageParam } : {}) })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  if (runs.error) return <ErrorState error={runs.error} retry={() => void runs.refetch()} />;
  if (!runs.data) return <LoadingState />;
  const items = runs.data.pages.flatMap((p) => p.items);
  if (!items.length) return <div className={styles.card}><EmptyState title={t("noRuns")} description={t("noRunsHint")} /></div>;
  return (
    <section className={styles.card} role="table" aria-label={t("tabLog")}>
      <div className={`${styles.lg} ${styles.lgHead}`} role="row">
        <div role="columnheader">{t("at")}</div><div role="columnheader">{t("rule")}</div><div role="columnheader">{t("detail")}</div><div role="columnheader">{t("result")}</div>
      </div>
      {items.map((r) => (
        <div key={r.id} className={styles.lg} role="row">
          <div role="cell" className={styles.muted}>{thTime.format(new Date(r.ranAt))}</div>
          <div role="cell">{r.rule.name}</div>
          <div role="cell">{[r.issueKeys.join(", "), detailText(r.detail, t)].filter(Boolean).join(" · ")}</div>
          <div role="cell"><span className={`${styles.pill} ${styles[RESULT_TONE[r.result]]}`}>{t(`result_${r.result}`)}</span></div>
        </div>
      ))}
      {runs.hasNextPage && <div className={styles.more}><Button disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>{t("more")}</Button></div>}
    </section>
  );
}

/** detail ของ automation_runs (A26 engine): steps ที่ทำ + เหตุผลที่ข้าม/ล้มเหลว */
function detailText(detail: unknown, t: ReturnType<typeof useTranslations>): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as { reason?: unknown; steps?: { action?: unknown; ok?: unknown; error?: unknown }[] };
  const parts: string[] = [];
  if (Array.isArray(d.steps)) {
    for (const s of d.steps) {
      const label = typeof s.action === "string" && t.has(`act_${s.action}`) ? t(`act_${s.action}`) : String(s.action ?? "");
      parts.push(s.ok === false ? `${label} ${t("stepFailed")}${typeof s.error === "string" ? ` (${s.error})` : ""}` : label);
    }
  }
  if (typeof d.reason === "string") parts.push(t.has(`reason_${d.reason}`) ? t(`reason_${d.reason}`) : d.reason);
  return parts.join(", ");
}
