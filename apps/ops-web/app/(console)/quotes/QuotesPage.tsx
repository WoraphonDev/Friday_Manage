"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Empty, ErrorBlock, ListBar, NoAccess, PageHead, Pager, SettingsButton, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, InlineError, Input, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { calendarDaysUntil } from "@/lib/format";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { useFmt } from "../workspaces/_parts/format";
import { QuoteDrawer } from "./_parts/QuoteDrawer";
import { type Quote, QuoteEditor, QUOTES_KEY } from "./_parts/QuoteEditor";

const PAGE = 50;
const TABS = ["draft", "sent", "accepted", "closed"] as const;
type Tab = (typeof TABS)[number];
interface Summary {
  sent: number;
  sentValueSatang: number;
  accepted90: number;
  contracts: number;
  todo: Quote[];
  tabs: Record<Tab, number>;
}
const daysLeft = (d: string) => Math.max(0, calendarDaysUntil(d));

/** ขายองค์กร › ใบเสนอราคาและสัญญา (O55 · storyboard เฟส 3 › Story 6) · Owner และการเงิน · ?new=1&lead=<id> เปิดตัวสร้างจาก Lead */
export function QuotesPage() {
  const t = useTranslations("quotes");
  const fmt = useFmt();
  const me = useMe().data;
  const read = hasAny(me, "owner", "finance");
  const [f, setF] = useUrlFilters({ tab: "sent", q: "", quote: "", new: "", lead: "", company: "" });
  const tab: Tab = (TABS as readonly string[]).includes(f.tab) ? (f.tab as Tab) : "sent";
  const [query, setQuery] = useState(f.q);
  const term = useDeferredValue(query.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [term, tab]);
  const summary = useQuery({ queryKey: [...QUOTES_KEY, "summary"], queryFn: () => api.get<Summary>("/quotes/summary"), enabled: read });
  const qs = new URLSearchParams({ tab, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}) });
  const list = useQuery({ queryKey: [...QUOTES_KEY, "list", qs.toString()], queryFn: () => api.get<{ items: Quote[]; total: number }>(`/quotes?${qs}`), enabled: read, placeholderData: keepPreviousData });
  const items = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (r) => setF({ quote: r.id }), labels: { down: tk("down"), open: tk("open") } });

  if (me && !read) return <NoAccess need={["owner", "finance"]} mine={rolesOf(me)} />;
  const s = summary.data;
  const extra = (x: Quote) => (x.reason === "approval" ? t("discountN", { pct: x.discountPct }) : x.reason === "setup" ? t("reason.setup") : x.viewCount ? t("viewsN", { n: x.viewCount }) : t("notViewed"));
  return (
    <>
      <PageHead
        title={t("title")}
        desc={s ? t("desc", { sent: s.sent, value: fmt.money(s.sentValueSatang), accepted: s.accepted90, contracts: s.contracts }) : "…"}
        actions={
          <>
            {hasAny(me, "owner") && (
              <SettingsButton title={t("settings.title")} description={t("settings.desc")}>
                <QuoteSettingsPanel />
              </SettingsButton>
            )}
            <Button variant="primary" onClick={() => setF({ new: "1", lead: "", company: "" })}>
              <Plus size={16} /> {t("new")}
            </Button>
          </>
        }
      />
      {summary.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <TodoCard title={t("todo")} count={summary.data.todo.length} hint={t("todoHint")} clear={{ title: t("clear"), description: t("clearNote") }}>
          {summary.data.todo.map((x) => (
            <article key={x.id} className="todo-row" aria-label={x.number}>
              <div className="todo-main">
                <span className="row">
                  <Pill tone={x.reason === "approval" ? "warn" : x.reason === "setup" ? "bad" : "inf"}>{x.reason === "expiring" ? t("reason.expiring", { days: daysLeft(x.validUntil) }) : t(`reason.${x.reason ?? "expiring"}` as "reason.approval")}</Pill>
                  <b>{t("todoLine", { number: x.number, company: x.company, extra: extra(x) })}</b>
                </span>
                <span className="muted small">{fmt.money(x.totalSatang)}</span>
              </div>
              <span className="todo-actions">
                <Button size="small" variant="primary" onClick={() => setF({ quote: x.id })}>
                  {t("view")}
                </Button>
              </span>
            </article>
          ))}
        </TodoCard>
      )}
      <section className="card">
        <ListBar tabs={<Tabs label={t("tabs.label")} value={tab} onChange={(v) => setF({ tab: v })} tabs={TABS.map((v) => ({ value: v, label: <>{t(`tabs.${v}`)} {s && <span className="tab-count">{fmt.num(s.tabs[v])}</span>}</> }))} />}>
          <div style={{ width: 240, flexShrink: 1, minWidth: 160 }}>
            <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </ListBar>
        {list.isPending ? (
          <TableSkeleton rows={5} cols={6} />
        ) : list.error ? (
          <ErrorBlock error={list.error} retry={() => void list.refetch()} />
        ) : !items.length ? (
          <Empty title={t("empty")} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.number")}</th>
                    <th scope="col">{t("col.company")}</th>
                    <th scope="col" className="num">
                      {t("col.total")}
                    </th>
                    <th scope="col">{t("col.term")}</th>
                    <th scope="col">{t("col.viewed")}</th>
                    <th scope="col">{t("col.until")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((x, i) => (
                    <tr key={x.id} className="row-link" aria-selected={f.quote === x.id} onClick={() => setF({ quote: x.id })} {...nav.rowProps(i)}>
                      <td className="mono">{x.number}</td>
                      <td>
                        {x.company}
                        {x.status !== "draft" && x.status !== "sent" && <div className="cell-sub">{t(`status.${x.status}`)}</div>}
                      </td>
                      <td className="num">{fmt.money(x.totalSatang)}</td>
                      <td>{t("monthsN", { n: x.months })}</td>
                      <td className="small">{x.viewCount ? `${t("viewsN", { n: x.viewCount })} · ${fmt.ago(x.lastViewedAt)}` : t("notViewed")}</td>
                      <td className="small">{fmt.date(x.validUntil)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={items.length} total={list.data.total} onChange={setOffset} hotkeys />
          </>
        )}
      </section>
      {f.quote && <QuoteDrawer key={f.quote} id={f.quote} onClose={() => setF({ quote: "" })} onOpen={(id) => setF({ quote: id })} />}
      {f.new && (
        <QuoteEditor
          lead={f.lead ? { id: f.lead, company: f.company } : undefined}
          onClose={() => setF({ new: "", lead: "", company: "" })}
          onSaved={(id) => setF({ quote: id, tab: "draft", new: "", lead: "", company: "" })}
        />
      )}
    </>
  );
}

function QuoteSettingsPanel() {
  const t = useTranslations("quotes.settings");
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...QUOTES_KEY, "settings"], queryFn: () => api.get<{ listPerSeatSatang: number; validDays: number }>("/quotes/settings") });
  const [list, setList] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.put("/quotes/settings", { listPerSeatSatang: Math.round(Number(list ?? (q.data!.listPerSeatSatang / 100)) * 100), validDays: Number(days ?? q.data!.validDays) }),
    onSuccess: () => (toast(t("saved")), void cache.invalidateQueries({ queryKey: QUOTES_KEY })),
  });
  if (!q.data) return <TableSkeleton rows={2} cols={2} />;
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), !m.isPending && m.mutate())}>
      <Input label={t("list")} type="number" min={1} value={list ?? String(q.data.listPerSeatSatang / 100)} onChange={(e) => setList(e.target.value)} />
      <Input label={t("validDays")} type="number" min={7} max={90} value={days ?? String(q.data.validDays)} onChange={(e) => setDays(e.target.value)} />
      <InlineError error={m.error} />
      <div className="dialog-actions">
        <Button type="submit" variant="primary" disabled={m.isPending || (list === null && days === null)}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
