"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { Empty, ErrorBlock, ListBar, NoAccess, PageHead, Pager, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, Input, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { planLabel, useFmt } from "../workspaces/_parts/format";
import styles from "./ratelimit.module.css";
import { NotifyDialog, RlDrawer } from "./_parts/Detail";
import { PLANS, RL_KEY, type RlRow, type RlSummary } from "./_parts/types";

const PAGE = 50;
const TABS = ["limited", "near", "overrides"] as const;
type Tab = (typeof TABS)[number];

/** ระบบ › Rate limit ต่อลูกค้า (O51 · storyboard เฟส 3 › Story 2) · Owner และวิศวกร */
export function RateLimitPage() {
  const t = useTranslations("rl");
  const fmt = useFmt();
  const me = useMe().data;
  const read = hasAny(me, "owner", "engineer");
  const defs: FilterDef[] = [
    { key: "plan", label: t("f.plan"), kind: "single", options: PLANS.map((p) => ({ value: p, label: planLabel(p) })) },
    { key: "overridden", label: t("f.overridden"), kind: "single", options: [{ value: "yes", label: t("f.yes") }, { value: "no", label: t("f.no") }] },
    { key: "minStreak", label: t("f.minStreak"), kind: "single", options: ["5", "15", "30", "60"].map((n) => ({ value: n, label: t("f.streakOpt", { n }) })) },
  ];
  const defaults: Record<string, string> = { tab: "limited", q: "", ws: "", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const tab: Tab = (TABS as readonly string[]).includes(f.tab) ? (f.tab as Tab) : "limited";
  const [query, setQuery] = useState(f.q);
  const term = useDeferredValue(query.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const fq = filterQuery(defs, f);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [term, tab, JSON.stringify(fq)]);
  const [notifying, setNotifying] = useState<RlRow | null>(null);

  const summary = useQuery({ queryKey: [...RL_KEY, "summary"], queryFn: () => api.get<RlSummary>("/ratelimit/summary"), enabled: read, refetchInterval: 60_000 });
  const qs = new URLSearchParams({ tab, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const list = useQuery({ queryKey: [...RL_KEY, "list", qs.toString()], queryFn: () => api.get<{ items: RlRow[]; total: number }>(`/ratelimit/workspaces?${qs}`), enabled: read, placeholderData: keepPreviousData });
  const items = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (r) => setF({ ws: r.id }), labels: { down: tk("down"), open: tk("open") } });

  if (me && !read) return <NoAccess need={["owner", "engineer"]} mine={rolesOf(me)} />;
  const s = summary.data;
  const lim = (n: number | null) => (n == null ? t("unlimited") : fmt.num(n));
  const filtered = !!term || Object.keys(fq).length > 0;
  return (
    <>
      <PageHead title={t("title")} desc={s ? t("desc", { limited: fmt.num(s.limited24h), rejected: fmt.num(s.rejected24h), overrides: fmt.num(s.tabs.overrides) }) : "…"} />

      {summary.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <TodoCard title={t("todo")} count={summary.data.todo.length} hint={t("todoHint", { n: summary.data.streakAlert })} clear={{ title: t("clear"), description: t("clearNote") }}>
          {summary.data.todo.map((r) => (
            <article key={r.id} className="todo-row" aria-label={r.name}>
              <div className="todo-main">
                <b>{r.name}</b>
                <span className="muted small">{t("todoLine", { plan: planLabel(r.plan), limit: lim(r.limit), token: r.topToken ?? "—" })}</span>
              </div>
              <span className="todo-actions">
                <span className={styles.streak}>{t("streak", { n: r.curStreak })}</span>
                <span className="muted small">{t("rejectedN", { n: fmt.num(r.rejected) })}</span>
                <Button size="small" onClick={() => setNotifying(r)}>
                  {t("notify")}
                </Button>
                <Button size="small" variant="primary" onClick={() => setF({ ws: r.id })}>
                  {t("view")}
                </Button>
              </span>
            </article>
          ))}
        </TodoCard>
      )}

      <section className="card">
        <ListBar
          tabs={
            <Tabs
              label={t("tabs.label")}
              value={tab}
              onChange={(v) => setF({ tab: v })}
              tabs={TABS.map((v) => ({ value: v, label: <>{t(`tabs.${v}`)} {s && <span className="tab-count">{fmt.num(s.tabs[v])}</span>}</> }))}
            />
          }
        >
          <div style={{ width: 260, flexShrink: 1, minWidth: 180 }}>
            <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <FilterButton defs={defs} values={f} onChange={setF} />
        </ListBar>
        <ActiveFilters defs={defs} values={f} onChange={setF} />
        {list.isPending ? (
          <TableSkeleton rows={5} cols={6} />
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
                    <th scope="col">{t("col.plan")}</th>
                    <th scope="col" className="num">
                      {t("col.limit")}
                    </th>
                    <th scope="col" className="num">
                      {t("col.peak")}
                    </th>
                    <th scope="col" className="num">
                      {t("col.rejected")}
                    </th>
                    <th scope="col">{t("col.token")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={r.id} className="row-link" aria-selected={f.ws === r.id} onClick={() => setF({ ws: r.id })} {...nav.rowProps(i)}>
                      <td>
                        <span className="cell-strong">{r.name}</span>
                        <div className="cell-sub mono">{r.slug}</div>
                      </td>
                      <td>{planLabel(r.plan)}</td>
                      <td className="num">
                        {lim(r.limit)}
                        {r.override && (
                          <>
                            {" "}
                            <Pill tone="inf">{t("adjusted")}</Pill>
                          </>
                        )}
                      </td>
                      <td className="num">
                        {fmt.num(r.peak)}
                        {r.usagePct != null && <div className="cell-sub">{fmt.num(r.usagePct)}%</div>}
                      </td>
                      <td className="num">{fmt.num(r.rejected)}</td>
                      <td className="mono small">{r.topToken ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={items.length} total={list.data.total} onChange={setOffset} hotkeys />
          </>
        )}
      </section>

      {f.ws && <RlDrawer key={f.ws} id={f.ws} onClose={() => setF({ ws: "" })} />}
      {notifying && <NotifyDialog id={notifying.id} name={notifying.name} onClose={() => setNotifying(null)} />}
    </>
  );
}
