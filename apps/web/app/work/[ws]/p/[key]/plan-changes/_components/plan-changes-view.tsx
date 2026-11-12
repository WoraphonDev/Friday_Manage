"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Badge, Button, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, type YearFormat, localeDateFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { List, Permissions, Person } from "@/lib/types";
import type { GanttData, GRow } from "../../gantt/_components/gantt-view";
import { showValue } from "../../../../import/_components/values";
import type { Member } from "../../../../import/_components/types";
import styles from "./plan-changes.module.css";

export interface Baseline {
  id: string;
  version: number;
  name: string;
  source: "import" | "manual" | string;
  itemCount: number;
  createdAt: string;
  createdBy: Person | null;
}
export interface PlanChange {
  id: string;
  issueKey: string;
  title: string;
  field: string;
  fieldLabel: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  impact: string | null;
  source: "manual" | "import" | "due_request";
  baselineVersion: number | null;
  changedBy: Person | null;
  changedAt: string;
}
export interface ModuleEnd {
  name: string;
  plan: string;
  forecast: string;
  /** วันปฏิทิน · บวก = ช้ากว่าแผน (ตรงกับ slipDays ของ Gantt) */
  days: number;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** วันจบตาม Baseline (งานที่อยู่ใน Baseline) เทียบวันจบปัจจุบันของ Module */
export function moduleEnds(d: GanttData): ModuleEnd[] {
  const out: ModuleEnd[] = [];
  for (const m of d.modules) {
    const rows: GRow[] = m.groups.flatMap((g) => g.tasks.flatMap((r) => [r, ...r.subtasks]));
    const plan = rows.reduce<string | null>((max, r) => (r.baseline?.end && (!max || r.baseline.end > max) ? r.baseline.end : max), null);
    if (!plan || !m.end) continue;
    out.push({ name: m.name, plan, forecast: m.end, days: daysBetween(plan, m.end) });
  }
  return out;
}

/** embedded = แสดงใน Popup Import / Export ของ Table หรือเมนู Settings (กรอบหน้าเป็นของผู้เรียก) */
export function PlanChangesView({ ws, projectKey, embedded = false }: { ws: string; projectKey: string; embedded?: boolean }) {
  const t = useTranslations("import-plan-changes.changes");
  const { me } = useWorkspace();
  const year: YearFormat = me.yearFormat;
  const toast = useToast();
  const cache = useQueryClient();
  const pathname = usePathname();
  const w = `/w/${encodeURIComponent(ws)}`;
  const base = `${w}/projects/${encodeURIComponent(projectKey)}`;
  const [picked, setPicked] = useState<number | null>(null);
  const [dialog, setDialog] = useState(false);

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const allowed = perms.isSuccess && !perms.data.guestViewer;
  const baselines = useQuery({ queryKey: ["baselines", ws, projectKey], queryFn: () => api.get<List<Baseline>>(`${base}/baselines`), enabled: allowed });
  const latest = baselines.data?.items.reduce((m, b) => Math.max(m, b.version), 0) ?? 0;
  useEffect(() => {
    if (picked === null && latest) setPicked(latest);
  }, [picked, latest]);
  const version = picked ?? (latest || null);

  const changes = useInfiniteQuery({
    queryKey: ["plan-changes", ws, projectKey, version],
    queryFn: ({ pageParam }) => api.get<List<PlanChange>>(`${base}/plan-changes?baseline=v${version}&limit=100${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: allowed && !!version,
  });
  const gantt = useQuery({
    queryKey: ["gantt", ws, projectKey, version],
    queryFn: () => api.get<GanttData>(`${base}/gantt?baseline=v${version}`),
    enabled: allowed && !!version,
  });
  // ชื่อ Dev สำหรับค่าใน assigneeIds (API เก็บเป็น userId)
  const members = useQuery({ queryKey: ["workspace", ws, "members"], queryFn: () => api.get<List<Member>>(`${w}/members`), enabled: allowed, retry: false });
  const names = useMemo(() => new Map((members.data?.items ?? []).map((m) => [m.userId, m.displayName])), [members.data]);

  const items = useMemo(() => changes.data?.pages.flatMap((p) => p.items) ?? [], [changes.data]);
  const mods = useMemo(() => (gantt.data ? moduleEnds(gantt.data) : []), [gantt.data]);

  const has = (p: string) => !!perms.data?.permissions.includes(p);
  const err = perms.error ?? baselines.error;
  if (perms.isPending || (allowed && baselines.isPending)) return <div className={embedded ? styles.body : styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer || (err instanceof ApiError && err.status === 403)) return <div className={embedded ? styles.body : styles.page}><Forbidden /></div>;
  if (err) return <div className={embedded ? styles.body : styles.page}><ErrorState error={err} retry={() => { void perms.refetch(); void baselines.refetch(); }} /></div>;

  const canBaseline = has("project.baseline");
  const current = baselines.data!.items.find((b) => b.version === version) ?? null;
  // อยู่ใน Popup Import / Export และเมนู Settings (ผู้ใช้ตัดสิน 2026-11-09) · ติดตามการแก้แผนเทียบ Baseline จากทุกช่องทาง
  const shell = (content: React.ReactNode) => <div className={embedded ? styles.body : styles.page}>{content}</div>;

  const value = (field: string, v: unknown) =>
    field === "assigneeIds" && Array.isArray(v) ? (v.length ? v.map((id) => names.get(String(id)) ?? String(id).slice(0, 8)).join(", ") : "—") : showValue(v, year);
  const text = (c: PlanChange) => [c.issueKey, c.title, `${c.fieldLabel}: ${value(c.field, c.oldValue)} → ${value(c.field, c.newValue)}`, c.reason, c.impact].filter(Boolean).join(" · ");

  async function copy() {
    try {
      await navigator.clipboard.writeText(items.map(text).join("\n"));
      toast({ message: t("copied", { count: items.length }) });
    } catch {
      toast({ message: t("copyFailed") });
    }
  }

  const openDialog = canBaseline && (
    <Button variant="primary" onClick={() => setDialog(true)}>{t("setBaseline", { version: latest + 1 })}</Button>
  );
  const baselineDialog = dialog && (
    <BaselineDialog
      next={latest + 1}
      onClose={() => setDialog(false)}
      onSave={async (name) => {
        const created = await api.post<Baseline>(`${base}/baselines`, name ? { name } : {});
        setDialog(false);
        toast({ message: t("created", { version: created.version }) });
        await cache.invalidateQueries({ queryKey: ["baselines", ws, projectKey] });
        void cache.invalidateQueries({ queryKey: ["gantt", ws, projectKey] });
        setPicked(created.version);
      }}
    />
  );

  if (!current) {
    return (
      shell(<>
        <section className={styles.card}><EmptyState title={t("noBaselineTitle")} description={t("noBaselineHint")} action={openDialog || undefined} /></section>
        {baselineDialog}
      </>)
    );
  }

  const issueCount = new Set(items.map((c) => c.issueKey)).size;
  const lateModules = mods.filter((m) => m.days > 0).length;
  const issueHref = (key: string) => `${pathname}?issue=${encodeURIComponent(key)}`;
  return (
    shell(<>
      <section className={`${styles.card} ${styles.top}`}>
        <div className={styles.topText}>
          <div className={styles.compare}>
            <b>{t("compare", { version: current.version })}</b>
            {baselines.data!.items.length > 1 && (
              <Select size="small" aria-label={t("baselineSelect")} value={String(current.version)} onChange={(e) => setPicked(Number(e.target.value))}>
                {baselines.data!.items.map((b) => <option key={b.version} value={b.version}>{t("baselineOption", { version: b.version, name: b.name })}</option>)}
              </Select>
            )}
            <span className="muted">{t("baselineMeta", { date: formatDate(current.createdAt, year, true), by: current.createdBy ? t("by", { name: current.createdBy.displayName }) : "" })}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{t("counts", { issues: issueCount, modules: lateModules })}</div>
        </div>
        <div className={styles.actions}>
          <Button disabled={!items.length} onClick={() => void copy()}>{t("copy")}</Button>
          <a className="button" href={`/api/v1${base}/plan-changes.xlsx?baseline=v${current.version}`} download>{t("export")}</a>
          {openDialog}
        </div>
      </section>

      <section className={styles.card} aria-label={t("modulesTitle")}>
        <div className={styles.cardHead}><b>{t("modulesTitle")}</b></div>
        {gantt.isPending ? <LoadingState /> : gantt.error ? <ErrorState error={gantt.error} retry={() => void gantt.refetch()} /> : mods.length === 0 ? (
          <div className="muted" style={{ padding: "12px 16px", fontSize: 12 }}>{t("noModules")}</div>
        ) : mods.map((m) => (
          <div key={m.name} className={styles.mod} data-testid="module-end">
            <b>{m.name}</b>
            <span><span className="muted">{t("plan")}</span> {formatDate(m.plan, year)}</span>
            <span><span className="muted">{t("forecast")}</span> {formatDate(m.forecast, year)}</span>
            <Badge tone={m.days > 0 ? "red" : "green"}>{m.days > 0 ? t("late", { days: m.days }) : m.days < 0 ? t("early", { days: -m.days }) : t("onPlan")}</Badge>
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <div className={`${styles.ch} ${styles.h}`}><span>{t("colNo")}</span><span>{t("colTask")}</span><span>{t("colField")}</span><span>{t("colValue")}</span><span className={styles.hs}>{t("colReason")}</span><span className={styles.hs}>{t("colBy")}</span></div>
        {changes.isPending ? <LoadingState /> : changes.error ? <ErrorState error={changes.error} retry={() => void changes.refetch()} /> : items.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyHint")} />
        ) : items.map((c) => (
          <div key={c.id} className={styles.ch} data-testid="plan-change">
            <span className={styles.mono}>{c.issueKey}</span>
            <span className={styles.task}>
              <Link href={issueHref(c.issueKey)} title={`${c.issueKey} ${c.title}`}>{c.title}</Link>
              <span className={`muted ${styles.sub}`}>{t(`source__${c.source}`)}</span>
            </span>
            <span>{c.fieldLabel}</span>
            <span><span className={styles.old}>{value(c.field, c.oldValue)}</span> → <span className={styles.new}>{value(c.field, c.newValue)}</span></span>
            <span className={`${styles.hs} ${styles.reason}`}>{c.reason ?? <span className="muted">{t("noReason")}</span>}{c.impact && <span className={`muted ${styles.sub}`}>{c.impact}</span>}</span>
            <span className={`${styles.hs} muted`} style={{ fontSize: 11 }}>{c.changedBy?.displayName ?? t("system")}<br />{when(c.changedAt, year)}</span>
          </div>
        ))}
        {changes.hasNextPage && (
          <div className={styles.more}><Button size="small" disabled={changes.isFetchingNextPage} onClick={() => void changes.fetchNextPage()}>{t("loadMore")}</Button></div>
        )}
        <div className={`muted ${styles.foot}`}>{t("footer")}</div>
      </section>
      {baselineDialog}
    </>)
  );
}

/** "6 พ.ย. 10:20" ตาม Canvas · เวลา Asia/Bangkok */
function when(iso: string, year: YearFormat) {
  const time = localeDateFormat({ hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(new Date(iso));
  return `${formatDate(iso, year).split(" ").slice(0, 2).join(" ")} ${time}`;
}

function BaselineDialog({ next, onClose, onSave }: { next: number; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const t = useTranslations("import-plan-changes.changes");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title={t("dialogTitle", { version: next })} description={t("dialogBody")} onOpenChange={(o) => { if (!o) onClose(); }}>
      <form
        className={styles.dialogBody}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSave(name.trim());
          } catch (failure) {
            setError(failure);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Input label={t("dialogName")} placeholder={`Baseline v${next}`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        {!!error && <ErrorState error={error} />}
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{t("submit")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
