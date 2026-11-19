"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { Empty, ErrorBlock, ListBar, Modal, NoAccess, PageHead, Pager, SettingsButton, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, InlineError, Input, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import styles from "./success.module.css";
import { PlaybooksPanel } from "./_parts/Playbooks";
import { healthClass, type Part, PARTS, RunDrawer, SUCCESS_KEY } from "./_parts/RunDrawer";

const PAGE = 50;
const TABS = ["active", "dropped", "recovered", "churned"] as const;
type Tab = (typeof TABS)[number];
const PLAYBOOKS = ["usage_drop", "overdue", "team_shrink", "tickets_backlog", "renewal_low_health"] as const;

interface Summary {
  paying: number;
  low: number;
  mrrAtRisk: number;
  recoveredPct: number | null;
  todo: {
    mine: number;
    overdue: number;
    items: { id: string; title: string; dueOn: string; assigneeId: string | null; assignee: string | null; runId: string; playbook: string; step: number; steps: number; workspaceId: string; workspace: string; score: number | null; overdue: boolean }[];
  };
  tabs: Record<Tab, number>;
}
interface Row {
  runId: string | null;
  workspaceId: string;
  name: string;
  slug: string;
  plan: string | null;
  score: number | null;
  score7: number | null;
  usage: number | null;
  payment: number | null;
  support: number | null;
  growth: number | null;
  playbook: string | null;
  status: string | null;
  closedAt: string | null;
  closeReason: string | null;
  owner: string | null;
  mrr: number | null;
  next: { id: string; title: string; kind: string; dueOn: string | null } | null;
}

/** ลูกค้า › สุขภาพและ Playbook (O53 · storyboard เฟส 3 › Story 4) · Owner และ Support */
export function SuccessPage() {
  const t = useTranslations("success");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const read = hasAny(me, "owner", "support");
  const owner = (me?.roles ?? []).includes("owner") || hasAny(me, "owner");
  const defs: FilterDef[] = [
    { key: "playbook", label: t("f.playbook"), kind: "single", options: PLAYBOOKS.map((p) => ({ value: p, label: t(`pbNames.${p}`) })) },
    { key: "owner", label: t("f.owner"), kind: "single", options: [{ value: "me", label: t("f.me") }] },
    { key: "weak", label: t("f.weak"), kind: "single", options: PARTS.map((p) => ({ value: p, label: t(`parts.${p}`) })) },
    { key: "plan", label: t("f.plan"), kind: "single", options: ["team_s", "team_m", "team_l", "enterprise"].map((p) => ({ value: p, label: planLabel(p) })) },
    { key: "minMrr", label: t("f.minMrr"), kind: "single", options: [100_000, 500_000, 1_000_000].map((n) => ({ value: String(n), label: t("f.mrrOpt", { n: fmt.money(n) }) })) },
    { key: "overdue", label: t("f.overdue"), kind: "single", options: [{ value: "true", label: t("f.overdueYes") }] },
  ];
  const defaults: Record<string, string> = { tab: "active", q: "", run: "", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const tab: Tab = (TABS as readonly string[]).includes(f.tab) ? (f.tab as Tab) : "active";
  const [query, setQuery] = useState(f.q);
  const term = useDeferredValue(query.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const fq = filterQuery(defs, f);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [term, tab, JSON.stringify(fq)]);
  const [starting, setStarting] = useState<Row | null>(null);

  const summary = useQuery({ queryKey: [...SUCCESS_KEY, "summary"], queryFn: () => api.get<Summary>("/success/summary"), enabled: read });
  const qs = new URLSearchParams({ tab, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const list = useQuery({ queryKey: [...SUCCESS_KEY, "runs", qs.toString()], queryFn: () => api.get<{ items: Row[]; total: number }>(`/success/runs?${qs}`), enabled: read, placeholderData: keepPreviousData });
  const items = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (r) => r.runId && setF({ run: r.runId }), labels: { down: tk("down"), open: tk("open") } });
  const snooze = useMutation({
    mutationFn: (id: string) => api.post<{ dueOn: string }>(`/success/steps/${id}/snooze`, { days: 1 }),
    onSuccess: (r) => (toast(t("snoozed", { date: fmt.date(r.dueOn) })), void cache.invalidateQueries({ queryKey: SUCCESS_KEY })),
  });

  if (me && !read) return <NoAccess need={["owner", "support"]} mine={rolesOf(me)} />;
  const s = summary.data;
  const weakOf = (r: Row) => {
    const parts = PARTS.filter((p) => r[p] != null).map((p) => [p, r[p] as number] as const);
    if (!parts.length) return null;
    const [p, v] = parts.sort((a, b) => a[1] - b[1])[0];
    return t("weakText", { part: t(`parts.${p as Part}`), pct: v });
  };
  const filtered = !!term || Object.keys(fq).length > 0;
  return (
    <>
      <PageHead
        title={t("title")}
        desc={s ? t("desc", { paying: fmt.num(s.paying), low: fmt.num(s.low), risk: fmt.money(s.mrrAtRisk), recovered: s.recoveredPct == null ? t("none") : `${s.recoveredPct}%` }) : "…"}
        actions={
          <SettingsButton title={t("pb.title")} description={t("pb.desc")}>
            <PlaybooksPanel canEdit={owner} />
          </SettingsButton>
        }
      />
      {summary.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <TodoCard title={t("todo")} count={summary.data.todo.items.length} hint={t("todoHint", { mine: summary.data.todo.mine, overdue: summary.data.todo.overdue })} clear={{ title: t("clear"), description: t("clearNote") }}>
          {summary.data.todo.items.map((x) => (
            <article key={x.id} className="todo-row" aria-label={x.workspace}>
              <div className="todo-main">
                <span className="row">
                  <span className={`${styles.score} ${healthClass(x.score)}`}>{x.score ?? "—"}</span>
                  <b>{x.workspace}</b>
                </span>
                <span className="small">{t("todoLine", { playbook: x.playbook, step: x.step, steps: x.steps, title: x.title })}</span>
                <span className="muted small">
                  {x.assignee ?? "—"} · {x.overdue ? t("dueLate", { date: fmt.date(x.dueOn) }) : t("dueToday")}
                </span>
              </div>
              <span className="todo-actions">
                <Button size="small" disabled={snooze.isPending} onClick={() => snooze.mutate(x.id)}>
                  {t("snooze")}
                </Button>
                <Button size="small" variant="primary" onClick={() => setF({ run: x.runId })}>
                  {t("record")}
                </Button>
              </span>
            </article>
          ))}
        </TodoCard>
      )}

      <section className="card">
        <ListBar
          tabs={<Tabs label={t("tabs.label")} value={tab} onChange={(v) => setF({ tab: v })} tabs={TABS.map((v) => ({ value: v, label: <>{t(`tabs.${v}`)} {s && <span className="tab-count">{fmt.num(s.tabs[v])}</span>}</> }))} />}
        >
          <div style={{ width: 240, flexShrink: 1, minWidth: 160 }}>
            <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <FilterButton defs={defs} values={f} onChange={setF} />
        </ListBar>
        <ActiveFilters defs={defs} values={f} onChange={setF} />
        {list.isPending ? (
          <TableSkeleton rows={5} cols={7} />
        ) : list.error ? (
          <ErrorBlock error={list.error} retry={() => void list.refetch()} />
        ) : !items.length ? (
          <Empty title={filtered ? t("empty.filtered") : t(`empty.${tab}`)} onClearFilters={filtered ? () => (setQuery(""), setF({ ...filterKeys(defs), q: "" })) : undefined} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.ws")}</th>
                    <th scope="col">{t("col.health")}</th>
                    <th scope="col">{t("col.weak")}</th>
                    <th scope="col">{t("col.playbook")}</th>
                    <th scope="col">{tab === "active" ? t("col.next") : tab === "dropped" ? "" : t("col.reason")}</th>
                    <th scope="col">{t("col.owner")}</th>
                    <th scope="col" className="num">
                      {t("col.mrr")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={r.runId ?? r.workspaceId} className={r.runId ? "row-link" : undefined} aria-selected={f.run === r.runId} onClick={() => r.runId && setF({ run: r.runId })} {...nav.rowProps(i)}>
                      <td>
                        <span className="cell-strong">{r.name}</span>
                        <div className="cell-sub">{planLabel(r.plan)}</div>
                      </td>
                      <td className="nowrap">
                        <span className={`${styles.score} ${healthClass(r.score)}`}>{r.score ?? "—"}</span>{" "}
                        {r.score != null && r.score7 != null && r.score7 > r.score && <span className={styles.delta}>↓{r.score7 - r.score}</span>}
                      </td>
                      <td className="small">{weakOf(r) ?? "—"}</td>
                      <td className="small">{r.playbook ?? "—"}</td>
                      <td className="small">
                        {tab === "dropped" ? (
                          <Button size="small" onClick={(e) => (e.stopPropagation(), setStarting(r))}>
                            {t("start")}
                          </Button>
                        ) : tab === "active" ? (
                          r.next ? (
                            <>
                              {r.next.title}
                              {r.next.dueOn && <div className="cell-sub">{fmt.date(r.next.dueOn)}</div>}
                            </>
                          ) : (
                            "—"
                          )
                        ) : (
                          <>
                            {r.closeReason ?? "—"}
                            {r.closedAt && <div className="cell-sub">{fmt.date(r.closedAt)}</div>}
                          </>
                        )}
                      </td>
                      <td className="small">{r.owner ?? "—"}</td>
                      <td className="num">{r.mrr != null ? fmt.money(r.mrr) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={items.length} total={list.data.total} onChange={setOffset} hotkeys />
          </>
        )}
      </section>
      {f.run && <RunDrawer key={f.run} id={f.run} onClose={() => setF({ run: "" })} />}
      {starting && <StartDialog row={starting} onClose={() => setStarting(null)} onStarted={(id) => setF({ run: id, tab: "active" })} />}
    </>
  );
}

function StartDialog({ row, onClose, onStarted }: { row: Row; onClose: () => void; onStarted: (id: string) => void }) {
  const t = useTranslations("success");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const pbs = useQuery({ queryKey: [...SUCCESS_KEY, "playbooks"], queryFn: () => api.get<{ items: { id: string; name: string; enabled: boolean }[] }>("/success/playbooks") });
  const [pb, setPb] = useState("");
  const choice = pb || pbs.data?.items[0]?.id || "";
  const m = useMutation({
    mutationFn: () => api.post<{ id: string }>("/success/runs", { workspaceId: row.workspaceId, playbookId: choice }),
    onSuccess: (r) => (toast(t("started")), void cache.invalidateQueries({ queryKey: SUCCESS_KEY }), onClose(), onStarted(r.id)),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("startTitle", { name: row.name })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), choice && !m.isPending && m.mutate())}>
        <Select label={t("f.playbook")} value={choice} onChange={(e) => setPb(e.target.value)}>
          {pbs.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!choice || m.isPending}>
            {t("start")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
