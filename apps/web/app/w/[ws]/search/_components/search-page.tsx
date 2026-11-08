"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { GROUPS, Highlight, HitStatus, SEARCH_TYPES, TypeIcon, hitHref, isIssue, savedSearchesKey, searchKey, type SavedSearch, type SearchHit, type SearchResult, type SearchType } from "@/features/command-palette/search-shared";
import styles from "./search.module.css";

const LIMIT = 100;
const SORTS = ["relevance", "updated", "due"] as const;
type Sort = (typeof SORTS)[number];
// ลำดับตัวกรองประเภทตาม Canvas
const TYPE_ORDER: SearchType[] = ["task", "sub", "bug", "file", "comment", "project", "person"];

/** ตัวกรองของหน้า · เก็บใน URL (แชร์ลิงก์ได้) และใน filters ของการค้นหาที่บันทึก */
interface Filters { q: string; types: SearchType[]; project: string; sort: Sort; archived: boolean; mine: boolean; open: boolean }

function parseFilters(source: { get(name: string): string | null }): Filters {
  const types = source.get("type")?.split(",").filter((x): x is SearchType => (SEARCH_TYPES as readonly string[]).includes(x));
  const sort = source.get("sort");
  return {
    q: source.get("q")?.trim() ?? "",
    types: types?.length ? types : [...SEARCH_TYPES],
    project: source.get("project") ?? "",
    sort: (SORTS as readonly string[]).includes(sort ?? "") ? (sort as Sort) : "relevance",
    archived: source.get("archived") === "1",
    mine: source.get("mine") === "1",
    open: source.get("open") === "1",
  };
}
function toQuery(f: Filters) {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.types.length !== SEARCH_TYPES.length) p.set("type", f.types.join(","));
  if (f.project) p.set("project", f.project);
  if (f.sort !== "relevance") p.set("sort", f.sort);
  if (f.archived) p.set("archived", "1");
  if (f.mine) p.set("mine", "1");
  if (f.open) p.set("open", "1");
  return p.toString();
}
/** filters ของ saved-search เป็น JSON อิสระ จึงแปลงกลับผ่านรูปแบบเดียวกับ URL */
function savedToFilters(s: SavedSearch): Filters {
  const f = s.filters;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const flag = (v: unknown) => (v === true ? "1" : null);
  const map: Record<string, string | null> = { q: s.query, type: Array.isArray(f.types) ? f.types.join(",") : null, project: str(f.project), sort: str(f.sort), archived: flag(f.archived), mine: flag(f.mine), open: flag(f.open) };
  return parseFilters({ get: (name) => map[name] ?? null });
}

export function SearchPage({ ws }: { ws: string }) {
  const t = useTranslations("search-palette");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workspace, projects, me } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const urlState = searchParams.toString();
  const [filters, setFilters] = useState<Filters>(() => parseFilters(searchParams));
  const [draft, setDraft] = useState(filters.q);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [removing, setRemoving] = useState<SavedSearch | null>(null);
  const base = `/w/${encodeURIComponent(ws)}`;
  const guest = workspace.role === "guest";

  // เปิดลิงก์ใหม่ (เช่นจาก Command palette) = อ่านตัวกรองจาก URL ใหม่
  useEffect(() => {
    const next = parseFilters(new URLSearchParams(urlState));
    setFilters(next);
    setDraft(next.q);
  }, [urlState]);

  function apply(next: Filters) {
    setFilters(next);
    setDraft(next.q);
    const qs = toQuery(next);
    router.replace(`${base}/search${qs ? `?${qs}` : ""}`, { scroll: false });
  }
  const patch = (p: Partial<Filters>) => apply({ ...filters, ...p });

  // ค้นทุกชนิดครั้งเดียวเพื่อได้ counts ของทุกประเภท · เลือกประเภทเดียว = ขอเฉพาะชนิดนั้นเพื่อให้ได้ครบ limit
  const common: Record<string, string> = { q: filters.q, limit: String(LIMIT), sort: filters.sort };
  if (filters.project) common.project = filters.project;
  if (filters.archived) common.archived = "true";
  const fetchSearch = (params: Record<string, string>) => api.get<SearchResult>(`${base}/search?${new URLSearchParams(params)}`);
  const all = useQuery({ queryKey: searchKey(ws, common), queryFn: () => fetchSearch(common), enabled: !!filters.q });
  const single = filters.types.length === 1 ? { ...common, type: filters.types[0]! } : null;
  const typed = useQuery({ queryKey: searchKey(ws, single ?? {}), queryFn: () => fetchSearch(single!), enabled: !!filters.q && !!single });
  // "มอบหมายให้ฉัน": search ยังไม่ส่งผู้รับผิดชอบ จึงใช้รายการงานของฉันจาก my-issues (A10) มาตัดแทน
  const mine = useQuery({
    queryKey: ["workspace", ws, "my-issues", "assigned", "keys"],
    queryFn: async () => new Set((await api.get<{ groups: { items: { key: string }[] }[] }>(`${base}/my-issues?tab=assigned&group=status`)).groups.flatMap((g) => g.items.map((i) => i.key))),
    enabled: !!filters.q && filters.mine,
  });
  const saved = useQuery({ queryKey: savedSearchesKey(ws), queryFn: () => api.get<{ items: SavedSearch[] }>(`${base}/saved-searches`) });

  const save = useMutation({
    mutationFn: (name: string) => api.post<SavedSearch>(`${base}/saved-searches`, { name, query: filters.q, filters: { types: filters.types, project: filters.project || undefined, sort: filters.sort, archived: filters.archived, mine: filters.mine, open: filters.open } }),
    onSuccess: async () => {
      setSaveOpen(false);
      toast({ message: t("page.saved") });
      await cache.invalidateQueries({ queryKey: savedSearchesKey(ws) });
    },
    onError: (e) => toast({ message: e instanceof Error ? e.message : String(e) }),
  });

  const source = single ? typed : all;
  const results = useMemo(() => {
    const items = source.data?.items ?? [];
    return items.filter((h) => {
      if (!filters.types.includes(h.type)) return false;
      if (filters.mine && !(isIssue(h) && mine.data?.has(h.key))) return false;
      if (filters.open && isIssue(h) && h.status.category === "done") return false;
      return true;
    });
  }, [source.data, filters.types, filters.mine, filters.open, mine.data]);
  const counts = all.data?.counts;
  const clientFiltered = filters.mine || filters.open;
  const total = clientFiltered ? results.length : filters.types.reduce((n, type) => n + (counts?.[type] ?? 0), 0);
  const capped = (source.data?.items.length ?? 0) >= LIMIT;

  const error = all.error ?? typed.error ?? mine.error;
  const pending = !!filters.q && (all.isPending || (!!single && typed.isPending) || (filters.mine && mine.isPending));

  function submit(event: FormEvent) {
    event.preventDefault();
    patch({ q: draft.trim() });
  }

  const typeRows = TYPE_ORDER.filter((type) => !(guest && type === "person"));
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1>{filters.q ? t("page.title", { q: filters.q }) : t("page.titleEmpty")}</h1>
          {filters.q && counts && <div className="muted">{t("page.summary", { count: total })}</div>}
        </div>
        <div className={styles.actions}>
          <Select size="small" aria-label={t("page.sortLabel")} value={filters.sort} onChange={(e) => patch({ sort: e.target.value as Sort })}>
            {SORTS.map((s) => <option key={s} value={s}>{t(`page.sort.${s}`)}</option>)}
          </Select>
          <Button disabled={!filters.q} onClick={() => { setSaveName(filters.q); setSaveOpen(true); }}>{t("page.save")}</Button>
        </div>
      </div>
      <form className={styles.form} role="search" onSubmit={submit}>
        <input className="input" type="search" aria-label={t("page.inputLabel")} placeholder={t("page.placeholder")} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="primary">{t("page.submit")}</Button>
      </form>
      <div className={styles.body}>
        <aside className={`${styles.card} ${styles.aside}`} aria-label={t("page.filters")}>
          <b>{t("page.typeHeading")}</b>
          {typeRows.map((type) => (
            <label key={type} className={styles.fchip}>
              <input type="checkbox" checked={filters.types.includes(type)} onChange={() => patch({ types: filters.types.includes(type) ? filters.types.filter((x) => x !== type) : TYPE_ORDER.filter((x) => x === type || filters.types.includes(x)) })} />
              <span>{t(`page.typeFilter.${type}`)}</span>
              {counts && <span className={styles.count}>{counts[type]}</span>}
            </label>
          ))}
          <b>{t("page.projectHeading")}</b>
          <label className={styles.fchip}>
            <input type="radio" name="search-project" checked={!filters.project} onChange={() => patch({ project: "" })} />
            <span>{t("page.allProjects")}</span>
          </label>
          {projects.map((p) => (
            <label key={p.id} className={styles.fchip}>
              <input type="radio" name="search-project" checked={filters.project === p.key} onChange={() => patch({ project: p.key })} />
              <span title={p.name}>{p.name}</span>
            </label>
          ))}
          <b>{t("page.otherHeading")}</b>
          <label className={styles.fchip}><input type="checkbox" checked={filters.mine} onChange={() => patch({ mine: !filters.mine })} /><span>{t("page.mine")}</span></label>
          <label className={styles.fchip}><input type="checkbox" checked={filters.open} onChange={() => patch({ open: !filters.open })} /><span>{t("page.open")}</span></label>
          <label className={styles.fchip}><input type="checkbox" checked={filters.archived} onChange={() => patch({ archived: !filters.archived })} /><span>{t("page.archived")}</span></label>
          <div className={styles.saved}>
            <b>{t("page.savedHeading")}</b>
            {saved.error ? <span className="field-error">{saved.error.message}</span> : saved.data && !saved.data.items.length ? <span className="muted" style={{ fontSize: 12 }}>{t("page.savedEmpty")}</span> : null}
            {saved.data?.items.map((s) => {
              const f = savedToFilters(s);
              return (
                <div key={s.id} className={styles.savedItem}>
                  <a href={`${base}/search?${toQuery(f)}`} onClick={(e) => { e.preventDefault(); apply(f); }}>{s.name}</a>
                  <Button size="icon" variant="ghost" aria-label={t("page.delete", { name: s.name })} onClick={() => setRemoving(s)}><X size={14} aria-hidden /></Button>
                </div>
              );
            })}
          </div>
        </aside>
        <section className={`${styles.card} ${styles.results}`} aria-label={t("page.results")}>
          {!filters.q ? (
            <EmptyState title={t("page.startTitle")} description={t("page.startHint")} />
          ) : pending ? (
            <LoadingState />
          ) : error ? (
            error instanceof ApiError && error.status === 403 ? <Forbidden /> : <ErrorState error={error} retry={() => { void all.refetch(); if (single) void typed.refetch(); if (filters.mine) void mine.refetch(); }} />
          ) : !results.length ? (
            <div className={styles.empty}><b>{t("page.noResults")}</b><p>{t("page.noResultsHint")}</p></div>
          ) : (
            <>
              {GROUPS.map((g) => {
                const hits = results.filter((h) => (g.types as readonly string[]).includes(h.type));
                if (!hits.length) return null;
                return (
                  // Canvas P1 แสดงรายการต่อกันไม่มีหัวกลุ่ม · คงกลุ่มไว้ให้โปรแกรมอ่านหน้าจอ
                  <div key={g.id} role="group" aria-label={t(`groups.${g.id}`)}>
                    {hits.map((h) => <Result key={`${h.type}:${hitId(h)}`} ws={ws} h={h} q={filters.q} year={me.yearFormat} />)}
                  </div>
                );
              })}
              {capped && <div className={styles.note}>{t("page.capped", { count: LIMIT })}</div>}
            </>
          )}
        </section>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen} title={t("page.saveTitle")} description={t("page.saveDescription")}>
        <form className={styles.dialogForm} onSubmit={(e) => { e.preventDefault(); if (saveName.trim()) save.mutate(saveName.trim()); }}>
          <Input label={t("page.saveName")} value={saveName} maxLength={80} onChange={(e) => setSaveName(e.target.value)} autoFocus />
          <div className={styles.dialogActions}>
            <Button onClick={() => setSaveOpen(false)}>{t("page.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!saveName.trim() || save.isPending}>{t("page.saveSubmit")}</Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title={t("page.deleteTitle", { name: removing?.name ?? "" })}
        description={t("page.deleteDescription")}
        confirmLabel={t("page.deleteConfirm")}
        successMessage={t("page.deleted")}
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`${base}/saved-searches/${removing.id}`);
          await cache.invalidateQueries({ queryKey: savedSearchesKey(ws) });
        }}
      />
    </div>
  );
}

const hitId = (h: SearchHit) => (h.type === "comment" ? h.commentId : h.type === "file" || h.type === "person" ? h.id : h.key);

function Result({ ws, h, q, year }: { ws: string; h: SearchHit; q: string; year: "BE" | "CE" }) {
  const t = useTranslations("search-palette");
  const href = hitHref(ws, h);
  let title: string;
  const meta: string[] = [t(`types.${h.type}`)];
  let snippet: string | null = null;
  switch (h.type) {
    case "project":
      title = h.name;
      meta.push(h.key);
      if (h.goliveDate) meta.push(t("meta.golive", { date: formatDate(h.goliveDate, year) }));
      break;
    case "comment":
      title = t("meta.commentIn", { key: h.issueKey, title: h.issueTitle });
      meta.push(h.project.name, formatDate(h.createdAt, year));
      snippet = h.snippet;
      break;
    case "file":
      title = h.name;
      meta.push(t("meta.files", { project: h.project.name }));
      break;
    case "person":
      title = h.displayName;
      meta.push(...[h.jobTitle, h.email].filter((x): x is string => !!x));
      break;
    default:
      title = `${h.key} ${h.title}`;
      meta.push(h.project.name);
      if (h.planEnd) meta.push(t("meta.due", { date: formatDate(h.planEnd, year) }));
      snippet = h.snippet;
  }
  return (
    <Link className={styles.res} href={href}>
      <TypeIcon type={h.type} size={30} />
      <div className={styles.resBody}>
        <div className={styles.resTitle}><Highlight text={title} q={q} /></div>
        <div className={styles.meta}>{meta.map((m, i) => <span key={i}>{m}</span>)}</div>
        {snippet && <div className={styles.snip}><Highlight text={snippet} q={q} /></div>}
      </div>
      {isIssue(h) && <span className={styles.pill}><HitStatus status={h.status} /></span>}
      {h.type === "project" && h.archived && <span className={styles.pill}><Badge>{t("meta.archived")}</Badge></span>}
    </Link>
  );
}
