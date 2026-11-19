"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { Empty, ErrorBlock, ListBar, Modal, NoAccess, PageHead, Pager, SettingsButton, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, InlineError, Input, Pill, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { useFmt } from "../workspaces/_parts/format";
import styles from "./abuse.module.css";
import { BlocksTab } from "./_parts/Blocks";
import { CaseDrawer, useDecide, useDur } from "./_parts/CaseDrawer";
import { RulesPanel } from "./_parts/Rules";
import { ABUSE_KEY, type Action, ageOf, BLOCK_KINDS, type CaseItem, KINDS, OUTCOME_TONE, OUTCOMES, scoreClass, type Summary, timeLeft } from "./_parts/types";

const PAGE = 50;
const TODO_PAGE = 50;

/** ความปลอดภัยและกฎหมาย › ตรวจจับการใช้ผิด (O50 · storyboard เฟส 3 › Story 1 · Canvas บอร์ด 15) · Owner และวิศวกร */
export function AbusePage() {
  const t = useTranslations("abuse");
  const fmt = useFmt();
  const durText = useDur();
  const me = useMe().data;
  const read = hasAny(me, "owner", "engineer");
  const summary = useQuery({ queryKey: [...ABUSE_KEY, "summary"], queryFn: () => api.get<Summary>("/abuse/summary"), enabled: read });
  const deciders = summary.data?.deciders ?? [];
  // ตัวกรองของแท็บประวัติ (เก็บใน URL) · คีย์ตรงกับ ops-api › abuse.service CasesQuery
  const defs: FilterDef[] = [
    { key: "kind", label: t("f.kind"), kind: "single", options: KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) })) },
    { key: "outcome", label: t("f.outcome"), kind: "single", options: OUTCOMES.map((o) => ({ value: o, label: t(`outcome.${o}`) })) },
    { key: "decidedBy", label: t("f.decidedBy"), kind: "single", options: deciders.map((d) => ({ value: d.id, label: d.name })) },
    { key: "when", label: t("f.when"), kind: "dates", fromKey: "from", toKey: "to" },
    { key: "minScore", label: t("f.minScore"), kind: "single", options: ["50", "70", "90"].map((n) => ({ value: n, label: t("f.score", { n }) })) },
  ];
  const blockDefs: FilterDef[] = [{ key: "bkind", label: t("blocks.kind"), kind: "single", options: BLOCK_KINDS.map((k) => ({ value: k, label: t(`blocks.kinds.${k}`) })) }];
  const defaults: Record<string, string> = { tab: "history", q: "", case: "", ...filterKeys(defs), ...filterKeys(blockDefs) };
  const [f, setF] = useUrlFilters(defaults);
  const tab = f.tab === "blocks" ? "blocks" : "history";
  const [query, setQuery] = useState(f.q);
  const term = useDeferredValue(query.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const [offset, setOffset] = useState(0);
  const [todoOffset, setTodoOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<{ ids: string[]; action: Action } | null>(null);
  const [adding, setAdding] = useState(false);
  const fq = filterQuery(defs, f);
  useEffect(() => setOffset(0), [term, tab, JSON.stringify(fq)]);

  const todo = useQuery({
    queryKey: [...ABUSE_KEY, "todo", todoOffset],
    queryFn: () => api.get<{ items: CaseItem[]; total: number }>(`/abuse/cases?tab=todo&limit=${TODO_PAGE}&offset=${todoOffset}`),
    enabled: read,
    placeholderData: keepPreviousData,
  });
  const hq = new URLSearchParams({ tab: "history", limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const history = useQuery({
    queryKey: [...ABUSE_KEY, "history", hq.toString()],
    queryFn: () => api.get<{ items: CaseItem[]; total: number }>(`/abuse/cases?${hq}`),
    enabled: read && tab === "history",
    placeholderData: keepPreviousData,
  });
  const items = todo.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (c) => setF({ case: c.id }), labels: { down: tk("down"), open: tk("open") } });
  const decide = useDecide(() => setSelected(new Set()));

  if (me && !read) return <NoAccess need={["owner", "engineer"]} mine={rolesOf(me)} />;
  const s = summary.data;
  const rangeSet = !!(f.from || f.to);
  const toggle = (id: string) => setSelected((cur) => (cur.has(id) ? (cur.delete(id), new Set(cur)) : new Set(cur.add(id))));
  const allPicked = items.length > 0 && items.every((c) => selected.has(c.id));
  const filtered = !!term || Object.keys(fq).length > 0;

  return (
    <>
      <PageHead
        title={t("title")}
        desc={s ? t("desc", { signups: fmt.num(s.signups7d), auto: fmt.num(s.autoSuspended7d), fp: s.falsePositivePct == null ? t("descNoFp") : `${s.falsePositivePct}%` }) : "…"}
        actions={
          <SettingsButton title={t("rules.title")} description={t("rules.desc")}>
            <RulesPanel />
          </SettingsButton>
        }
      />

      {todo.isPending ? (
        <TableSkeleton rows={3} cols={4} />
      ) : todo.error ? (
        <ErrorBlock error={todo.error} retry={() => void todo.refetch()} />
      ) : (
        <TodoCard
          title={t("todo")}
          count={todo.data.total}
          hint={s ? t("todoHint", { open: s.todo.open, auto: s.todo.autoSuspended, age: durText(ageOf(s.todo.oldestAt)) }) : undefined}
          clear={{ title: t("clear"), description: t("clearNote") }}
        >
          {selected.size > 0 && (
            <div className={styles.bulk} role="group" aria-label={t("bulkTitle", { count: selected.size })}>
              <b>{t("selected", { count: selected.size })}</b>
              <Button size="small" onClick={() => setDeciding({ ids: [...selected], action: "dismiss" })}>
                {t("dismiss")}
              </Button>
              <Button size="small" onClick={() => setDeciding({ ids: [...selected], action: "suspend" })}>
                {t("action.suspend")}
              </Button>
              <Button size="small" variant="danger" onClick={() => setDeciding({ ids: [...selected], action: "block" })}>
                {t("action.block")}
              </Button>
              <Button size="small" variant="ghost" className="push-end" onClick={() => setSelected(new Set())}>
                {t("clearSelection")}
              </Button>
            </div>
          )}
          {items.length > 1 && (
            <label className={`row small muted ${styles.selectAll}`}>
              <input type="checkbox" className="check" checked={allPicked} onChange={() => setSelected(allPicked ? new Set() : new Set(items.map((c) => c.id)))} />
              {t("selectAll")}
            </label>
          )}
          {items.map((c, i) => {
            const left = timeLeft(c.confirmBy);
            const main = [...c.signals].sort((a, b) => b.points - a.points)[0];
            return (
              <article key={c.id} className="todo-row" aria-label={c.label} {...nav.rowProps(i)}>
                <input type="checkbox" className="check" aria-label={t("select", { label: c.label })} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <button type="button" className={`todo-main row-link-button ${styles.caseRow}`} onClick={() => setF({ case: c.id })}>
                  <span className={scoreClass(c.score)}>{c.score}</span>
                  <span className={styles.caseText}>
                    <span className={styles.caseTitle}>
                      <Pill tone="neu">{t(`kind.${c.kind}`)}</Pill>
                      <b>{c.label}</b>
                    </span>
                    {main && <span className="muted small">{main.detail}</span>}
                  </span>
                </button>
                <span className="todo-actions">
                  {c.status === "auto_suspended" && <Pill tone="bad">{left ? t("suspendedLeft", { left: durText(left) }) : t("suspendedOver")}</Pill>}
                  <Button size="small" onClick={() => setDeciding({ ids: [c.id], action: "dismiss" })}>
                    {t("dismiss")}
                  </Button>
                </span>
              </article>
            );
          })}
          {todo.data.total > TODO_PAGE && <Pager offset={todoOffset} limit={TODO_PAGE} shown={items.length} total={todo.data.total} onChange={setTodoOffset} />}
        </TodoCard>
      )}

      <section className="card">
        <ListBar
          tabs={
            <Tabs
              label={t("tabs.label")}
              value={tab}
              onChange={(v) => setF({ tab: v })}
              tabs={[
                { value: "history", label: <>{rangeSet ? t("tabs.historyRange") : t("tabs.history")} {s && <span className="tab-count">{fmt.num(s.tabs.history)}</span>}</> },
                { value: "blocks", label: <>{t("tabs.blocks")} {s && <span className="tab-count">{fmt.num(s.tabs.blocks)}</span>}</> },
              ]}
            />
          }
        >
          <div style={{ width: 280, flexShrink: 1, minWidth: 180 }}>
            <Input data-page-search type="search" aria-label={tab === "blocks" ? t("searchBlocks") : t("search")} placeholder={tab === "blocks" ? t("searchBlocks") : t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {tab === "history" ? (
            <FilterButton defs={defs} values={f} onChange={setF} />
          ) : (
            <>
              <FilterButton defs={blockDefs} values={f} onChange={setF} />
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus size={16} /> {t("blocks.add")}
              </Button>
            </>
          )}
        </ListBar>
        <ActiveFilters defs={tab === "history" ? defs : blockDefs} values={f} onChange={setF} />
        {tab === "blocks" ? (
          <BlocksTab q={term} kind={f.bkind} adding={adding} onAdding={setAdding} />
        ) : history.isPending ? (
          <TableSkeleton rows={5} cols={6} />
        ) : history.error ? (
          <ErrorBlock error={history.error} retry={() => void history.refetch()} />
        ) : !history.data.items.length ? (
          <Empty title={filtered ? t("empty") : t("emptyHistory")} onClearFilters={filtered ? () => (setQuery(""), setF({ ...filterKeys(defs), q: "" })) : undefined} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.date")}</th>
                    <th scope="col">{t("col.kind")}</th>
                    <th scope="col">{t("col.who")}</th>
                    <th scope="col" className="num">
                      {t("col.score")}
                    </th>
                    <th scope="col">{t("col.outcome")}</th>
                    <th scope="col">{t("col.by")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.items.map((c) => (
                    <tr key={c.id} className="row-link" aria-selected={f.case === c.id} onClick={() => setF({ case: c.id })}>
                      <td className="nowrap">{fmt.dateTime(c.decidedAt)}</td>
                      <td>{t(`kind.${c.kind}`)}</td>
                      <td>
                        <span className="cell-strong">{c.label}</span>
                        {c.reason && <div className="cell-sub clamp-1">{c.reason}</div>}
                      </td>
                      <td className="num">{c.score}</td>
                      <td>{c.outcome && <Pill tone={OUTCOME_TONE[c.outcome]}>{t(`outcome.${c.outcome}`)}</Pill>}</td>
                      <td className="small">{c.decidedBy ?? t("system")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={history.data.items.length} total={history.data.total} onChange={setOffset} hotkeys />
          </>
        )}
      </section>

      {f.case && <CaseDrawer key={f.case} id={f.case} onClose={() => setF({ case: "" })} onNext={(id) => setF({ case: id ?? "" })} />}
      {deciding && <DecideDialog {...deciding} pending={decide.isPending} error={decide.error} onClose={() => setDeciding(null)} onSubmit={(reason) => decide.mutate({ ...deciding, reason }, { onSuccess: () => setDeciding(null) })} />}
    </>
  );
}

/** ตัดสินจากแถบต้องทำ (ไม่ใช่การใช้ผิด) หรือหลายเคสพร้อมกัน · ต้องมีเหตุผลเสมอ */
function DecideDialog({ ids, action, pending, error, onClose, onSubmit }: { ids: string[]; action: Action; pending: boolean; error: unknown; onClose: () => void; onSubmit: (reason: string) => void }) {
  const t = useTranslations("abuse");
  const tc = useTranslations("common.dialog");
  const [reason, setReason] = useState("");
  const label = action === "dismiss" ? t("dismiss") : action === "block" ? t("action.block") : action === "verify_identity" ? t("action.verify") : t("action.suspend");
  const ok = reason.trim().length >= 3 && !pending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={ids.length > 1 ? `${label} · ${t("bulkTitle", { count: ids.length })}` : label}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && onSubmit(reason.trim()))}>
        <Textarea label={t("drawer.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant={action === "dismiss" ? "primary" : "danger"} disabled={!ok}>
            {label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
