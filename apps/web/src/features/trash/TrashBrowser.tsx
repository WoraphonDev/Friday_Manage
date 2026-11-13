"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button, EmptyState, ErrorState, Forbidden, LoadingState, Select, useToast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";
import { fetchTrash, restoreItems, trashKeys, type TrashFilters, type TrashScope } from "./api";
import { PurgeDialog, RestoreProjectDialog } from "./dialogs";
import { deleterText, formatBytes, formatDateTime } from "./format";
import { URGENT_DAYS, type TrashIssue, type TrashItem, type TrashList, type TrashProject, type TrashType } from "./types";
import styles from "./trash.module.css";

const EMPTY: TrashFilters = { type: "issue", q: "", project: "", deletedBy: "" };

/**
 * ตารางถังขยะ · Z1 (ทั้ง Workspace ใน Admin Console) และ Z4 (ของโปรเจกต์ใน Project Settings)
 * ปุ่มลบถาวรแสดงตาม `can.purge` ของ API (Owner เท่านั้น) · มือถือแสดงเป็นการ์ด
 */
export function TrashBrowser({ ws, projectKey, heading }: TrashScope & { heading?: (list: TrashList | undefined) => React.ReactNode }) {
  const t = useTranslations("trash");
  const toast = useToast();
  const cache = useQueryClient();
  const router = useRouter();
  const scope: TrashScope = { ws, projectKey };
  const types: TrashType[] = projectKey ? ["issue", "file"] : ["project", "issue", "file"];
  const [filters, setFilters] = useState<TrashFilters>(EMPTY);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState<TrashProject | null>(null);
  const [purging, setPurging] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  // ค้นหาหลังหยุดพิมพ์ 250 ms
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === draft ? f : { ...f, q: draft })), 250);
    return () => clearTimeout(id);
  }, [draft]);
  useEffect(() => setSelected(new Set()), [filters]);

  const query = useInfiniteQuery({
    queryKey: trashKeys.list(scope, filters),
    queryFn: ({ pageParam }) => fetchTrash(scope, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const first = query.data?.pages[0];
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  // ชุดใหญ่ข้ามหลายหน้า API ส่งชุดเดียวกันมากับทุกหน้า · เก็บครั้งเดียวต่อ id
  const batches = useMemo(() => [...new Map((query.data?.pages.flatMap((p) => p.batches) ?? []).map((b) => [b.id, b])).values()], [query.data]);
  // ชุดที่ใหญ่กว่าหน้าที่โหลด (เช่น ลบ 536 งานจาก Table): งานที่ยังไม่โหลดใช้ key จากชุด ให้เลือก / กู้คืน / ลบถาวรได้ทั้งชุดในครั้งเดียว
  const byId = useMemo(() => {
    const map = new Map<string, TrashItem>(items.map((i) => [i.id, i]));
    for (const b of batches) {
      const seen = items.find((i): i is TrashIssue => i.type === "issue" && i.batchId === b.id);
      if (!seen) continue;
      b.ids.forEach((id, n) => {
        const key = b.keys[n] ?? "";
        if (!map.has(id)) map.set(id, { ...seen, id, key, title: "", subtasks: 0, project: b.projects.find((p) => key.startsWith(`${p.key}-`)) ?? seen.project });
      });
    }
    return map;
  }, [items, batches]);
  const chosen = [...selected].map((id) => byId.get(id)).filter((x): x is TrashItem => !!x);

  if (query.error instanceof ApiError && query.error.status === 403) return <Forbidden />;

  const refresh = async () => {
    setSelected(new Set());
    await cache.invalidateQueries({ queryKey: trashKeys.all(ws) });
  };
  async function restore(list: TrashItem[]) {
    if (!list.length) return;
    if (list[0]!.type === "project") return setRestoring(list[0] as TrashProject);
    setBusy(true);
    try {
      const type = list[0]!.type as "issue" | "file";
      const r = await restoreItems(ws, type, list.map((i) => i.id));
      if (r.failed.length) toast({ tone: "error", message: t("partial", { ok: r.restored.length, failed: r.failed.length, reason: r.failed[0]!.message }) });
      else toast({ message: list.length === 1 ? t("restoredOne", { name: nameOf(list[0]!) }) : t("restored", { n: r.restored.length }) });
      await refresh();
    } catch (e) {
      toast({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const filtered = !!(filters.q || filters.project || filters.deletedBy);
  const canPurge = !!first?.can.purge;
  const type = filters.type;
  // Sub-task ของชุดที่เลือกครบใช้ยอดของชุด (งานที่ยังไม่โหลดไม่รู้จำนวนรายงาน)
  const fullBatches = batches.filter((b) => b.ids.every((id) => selected.has(id)));
  const inFull = new Set(fullBatches.flatMap((b) => b.ids));
  const subtasks = fullBatches.reduce((n, b) => n + b.subtasks, 0) + chosen.reduce((n, i) => n + (i.type === "issue" && !inFull.has(i.id) ? i.subtasks : 0), 0);

  const daysPill = (i: TrashItem) => (
    <span className={cn(styles.days, i.daysLeft <= URGENT_DAYS && styles.urgent)}>{i.daysLeft > 0 ? t("days", { n: i.daysLeft }) : t("dueToday")}</span>
  );
  const nameCell = (i: TrashItem) => {
    if (i.type === "issue")
      return (
        <span className={styles.name}>
          <b>
            <span className={styles.key}>{i.key}</span>
            {i.title}
          </b>
          {i.subtasks > 0 && <span className={styles.small}>{t("withSubtasks", { n: i.subtasks })}</span>}
        </span>
      );
    if (i.type === "file")
      return (
        <span className={styles.name}>
          <b>{i.name}</b>
          <span className={styles.small}>{[i.folder ? t("inFolder", { folder: i.folder }) : null, formatBytes(i.sizeBytes)].filter(Boolean).join(" · ")}</span>
        </span>
      );
    return (
      <span className={styles.name}>
        <b>
          <span className={styles.key}>{i.key}</span>
          {i.name}
          {i.archived && <span className={styles.tag}>{t("archivedTag")}</span>}
        </b>
        <span className={styles.small}>
          {t("projectCounts", i.counts)}
          {i.keyTaken && ` · ${t("keyTakenShort")}`}
        </span>
      </span>
    );
  };

  return (
    <div className={styles.wrap}>
      {heading?.(first)}
      <div className={styles.toolbar}>
        <div className={styles.seg} role="tablist" aria-label={t("tabsLabel")}>
          {types.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={type === k} onClick={() => setFilters({ ...EMPTY, type: k })}>
              {t(`tab.${k}`)} {first?.counts[k] ?? ""}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t(type === "file" ? "searchFile" : type === "project" ? "searchProject" : "search")} aria-label={t(type === "file" ? "searchFile" : type === "project" ? "searchProject" : "search")} />
        </label>
        {!projectKey && type !== "project" && (
          <div className={styles.filter}>
            <Select size="small" aria-label={t("projectFilter")} value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
              <option value="">{t("allProjects")}</option>
              {first?.projects.map((p) => (
                <option key={p.id} value={p.key}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className={styles.filter}>
          <Select size="small" prefix={t("deleterPrefix")} aria-label={t("deleterFilter")} value={filters.deletedBy} onChange={(e) => setFilters({ ...filters, deletedBy: e.target.value })}>
            <option value="">{t("everyone")}</option>
            {first?.deleters.map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {chosen.length > 0 && (
        <div className={styles.selbar} role="region" aria-label={type === "issue" ? t("selectedIssues", { n: chosen.length }) : t("selected", { n: chosen.length })}>
          <b>{type === "issue" ? t("selectedIssues", { n: chosen.length }) : t("selected", { n: chosen.length })}</b>
          {subtasks > 0 && <span className={styles.sub}>{t("selectedSubtasks", { n: subtasks })}</span>}
          <span className={styles.grow} />
          <Button size="small" onClick={() => setSelected(new Set())}>
            {t("clearSelection")}
          </Button>
          {(type !== "project" || chosen.length === 1) && (
            <Button size="small" variant="primary" disabled={busy} onClick={() => void restore(chosen)}>
              {type === "issue" ? t("restoreIssuesN", { n: chosen.length }) : t("restoreN", { n: chosen.length })}
            </Button>
          )}
          {canPurge && (
            <Button size="small" onClick={() => setPurging(chosen)}>
              {t("purge")}
            </Button>
          )}
        </div>
      )}

      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        filtered ? (
          <EmptyState title={t("noMatch")} description="" action={<Button onClick={() => (setDraft(""), setFilters({ ...EMPTY, type }))}>{t("clearFilters")}</Button>} />
        ) : (
          <EmptyState title={t("empty")} description={t("emptyDesc", { days: first?.trashDays ?? 30 })} />
        )
      ) : (
        <>
          <div className={cn(styles.table, projectKey && styles.noProject)} role="table" aria-label={t(`tab.${type}`)}>
            <div className={styles.thead} role="row">
              <span role="columnheader">
                <input type="checkbox" className={styles.check} aria-label={t("selectAll")} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} />
              </span>
              <span role="columnheader">{t(`col.${type}`)}</span>
              {!projectKey && <span role="columnheader">{type === "project" ? "" : t("col.inProject")}</span>}
              <span role="columnheader">{t("col.deletedBy")}</span>
              <span role="columnheader">{t("col.deletedAt")}</span>
              <span role="columnheader">{t("col.purge")}</span>
              <span role="columnheader" />
            </div>
            {items.map((i) => (
              <div key={i.id} className={styles.row} role="row" data-selected={selected.has(i.id)}>
                <span role="cell">
                  <input type="checkbox" className={styles.check} aria-label={t("selectRow", { name: nameOf(i) })} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                </span>
                <span role="cell" className={styles.cell}>
                  {nameCell(i)}
                </span>
                {!projectKey && (
                  <span role="cell" className={styles.cell}>
                    {i.type === "project" ? "" : i.project.name}
                  </span>
                )}
                <span role="cell" className={styles.cell}>
                  {deleterText(t, i.deletedBy)}
                </span>
                <span role="cell" className={styles.cell}>
                  {formatDateTime(i.deletedAt)}
                </span>
                <span role="cell">{daysPill(i)}</span>
                <span role="cell">
                  <Button size="small" disabled={busy} aria-label={t("restoreName", { name: nameOf(i) })} onClick={() => void restore([i])}>
                    {t("restore")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
          <div className={styles.cards}>
            {items.map((i) => (
              <article key={i.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.key}>{i.type === "file" ? formatBytes(i.sizeBytes) : i.key}</span>
                  {daysPill(i)}
                </div>
                <b>{i.type === "issue" ? i.title : i.name}</b>
                <div className={styles.cardFoot}>
                  <span className={styles.small}>
                    {t("col.deletedBy")} {i.deletedBy?.displayName ?? t("unknownUser")} · {i.type === "issue" && i.subtasks > 0 ? t("withSubtasks", { n: i.subtasks }) : formatDateTime(i.deletedAt)}
                  </span>
                  <Button size="small" disabled={busy} aria-label={t("restoreName", { name: nameOf(i) })} onClick={() => void restore([i])}>
                    {t("restore")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {type === "issue" &&
            batches.map((b) => (
              <div key={b.id} className={styles.batch} role="note">
                <span>
                  {t("batch", { n: b.count, project: b.projects.map((p) => p.name).join(", "), at: formatDateTime(b.deletedAt), by: b.deletedBy?.displayName ?? t("unknownUser") })}
                </span>
                ·
                <button type="button" className={styles.linkBtn} onClick={() => setSelected(new Set(b.ids))}>
                  {t("batchSelect")}
                </button>
              </div>
            ))}
          {query.hasNextPage && (
            <div className={styles.more}>
              <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {t("loadMore")}
              </Button>
            </div>
          )}
        </>
      )}

      {restoring && (
        <RestoreProjectDialog
          ws={ws}
          item={restoring}
          onClose={() => setRestoring(null)}
          onRestored={(key) => {
            setRestoring(null);
            toast({ message: t("rp.done", { key }), actions: [{ label: t("rp.open"), href: `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(key)}` }] });
            void refresh();
            void cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
            router.refresh();
          }}
        />
      )}
      {purging && (
        <PurgeDialog
          ws={ws}
          type={type}
          items={purging}
          onClose={() => setPurging(null)}
          onPurged={(n) => {
            setPurging(null);
            toast({ message: t("purged", { n }) });
            void refresh();
          }}
        />
      )}
    </div>
  );
}

const nameOf = (i: TrashItem) => (i.type === "file" ? i.name : i.type === "issue" ? `${i.key} ${i.title}` : `${i.key} · ${i.name}`);

/** หัวของ Z1 ใน Admin Console: คำอธิบายพร้อมลิงก์ไปตั้งค่าระยะถังขยะ */
export function WorkspaceTrashHead({ ws, days }: { ws: string; days: number }) {
  const t = useTranslations("trash");
  const [before, after] = t("desc", { days }).split(t("settingsLink"));
  return (
    <span>
      {before}
      <Link href={`/work/${encodeURIComponent(ws)}/admin/data`}>{t("settingsLink")}</Link>
      {after}
    </span>
  );
}
