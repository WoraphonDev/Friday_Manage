"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { Empty, ErrorBlock, ListBar, Modal, NoAccess, PageHead, Pager, SettingsButton, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, InlineError, Input, Pill, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { useFmt } from "../workspaces/_parts/format";
import { type Lead, LeadDrawer, LEADS_KEY, type Stage, STAGES } from "./_parts/LeadDrawer";

const PAGE = 50;
interface Summary {
  open: number;
  pipelineSatang: number;
  won90: number;
  lost90: number;
  stages: Record<Stage, { n: number; value: number }>;
  todo: { items: (Lead & { late: boolean })[]; uncontacted: number; late: number; due: number };
}

/** ขายองค์กร › Lead และดีล (O54 · storyboard เฟส 3 › Story 5) · Owner */
export function LeadsPage() {
  const t = useTranslations("leads");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const read = hasAny(me, "owner");
  const defs: FilterDef[] = [
    { key: "source", label: t("f.source"), kind: "single", options: (["form", "trial", "manual"] as const).map((s) => ({ value: s, label: t(`source.${s}`) })) },
    { key: "owner", label: t("f.owner"), kind: "single", options: [{ value: "me", label: t("f.me") }] },
    { key: "minValue", label: t("f.minValue"), kind: "single", options: [10_000_000, 50_000_000, 100_000_000].map((n) => ({ value: String(n), label: t("f.valueOpt", { v: fmt.money(n) }) })) },
    { key: "overdue", label: t("f.overdue"), kind: "single", options: [{ value: "true", label: t("f.overdueYes") }] },
    { key: "created", label: t("f.created"), kind: "dates", fromKey: "from", toKey: "to" },
  ];
  const defaults: Record<string, string> = { stage: "contacted", q: "", lead: "", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const stage: Stage = (STAGES as readonly string[]).includes(f.stage) ? (f.stage as Stage) : "contacted";
  const [query, setQuery] = useState(f.q);
  const term = useDeferredValue(query.trim());
  useEffect(() => {
    if (term !== f.q) setF({ q: term });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);
  const fq = filterQuery(defs, f);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [term, stage, JSON.stringify(fq)]);
  const [adding, setAdding] = useState(false);

  const summary = useQuery({ queryKey: [...LEADS_KEY, "summary"], queryFn: () => api.get<Summary>("/leads/summary"), enabled: read });
  const qs = new URLSearchParams({ stage, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}), ...fq });
  const list = useQuery({ queryKey: [...LEADS_KEY, "list", qs.toString()], queryFn: () => api.get<{ items: Lead[]; total: number }>(`/leads?${qs}`), enabled: read, placeholderData: keepPreviousData });
  const items = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(items, { onOpen: (r) => setF({ lead: r.id }), labels: { down: tk("down"), open: tk("open") } });
  const claim = useMutation({
    mutationFn: (id: string) => api.post(`/leads/${id}/claim`),
    onSuccess: (_r, id) => (toast(t("claimed")), void cache.invalidateQueries({ queryKey: LEADS_KEY }), setF({ lead: id })),
  });

  if (me && !read) return <NoAccess need={["owner"]} mine={rolesOf(me)} />;
  const s = summary.data;
  const filtered = !!term || Object.keys(fq).length > 0;
  const closed = stage === "won" || stage === "lost";
  return (
    <>
      <PageHead
        title={t("title")}
        desc={s ? t("desc", { open: fmt.num(s.open), value: fmt.money(s.pipelineSatang), won: s.won90, lost: s.lost90 }) : "…"}
        actions={
          <>
            <SettingsButton title={t("settings.title")} description={t("settings.desc")}>
              <LeadSettingsPanel />
            </SettingsButton>
            <a className="button" href={`${OPS_BASE}/leads/export?${qs}`}>
              {t("export")}
            </a>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> {t("add")}
            </Button>
          </>
        }
      />
      {summary.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <TodoCard title={t("todo")} count={summary.data.todo.items.length} hint={t("todoHint", { new: summary.data.todo.uncontacted, late: summary.data.todo.late, due: summary.data.todo.due })} clear={{ title: t("clear"), description: t("clearNote") }}>
          {summary.data.todo.items.map((l) => (
            <article key={l.id} className="todo-row" aria-label={l.company}>
              <div className="todo-main">
                <span className="row">
                  <Pill tone={l.source === "form" ? "inf" : l.source === "trial" ? "ok" : "neu"}>{t(`source.${l.source}`)}</Pill>
                  <b>{l.company}</b>
                  {l.teamSize ? <span className="muted small">{l.source === "trial" ? t("seatsN", { n: l.teamSize }) : t("peopleN", { n: fmt.num(l.teamSize) })}</span> : null}
                </span>
                <span className="small clamp-1">{l.stage === "new" ? (l.message ?? l.needs.map((n) => t(`needs.${n}` as "needs.sso")).join(" · ")) : `${l.nextAction ?? ""}`}</span>
              </div>
              <span className="todo-actions">
                <span className={l.late ? "text-danger small" : "muted small"}>{l.late ? t("late") : fmt.ago(l.createdAt)}</span>
                {l.stage === "new" && !l.ownerId ? (
                  <Button size="small" variant="primary" disabled={claim.isPending} onClick={() => claim.mutate(l.id)}>
                    {t("claim")}
                  </Button>
                ) : (
                  <Button size="small" onClick={() => setF({ lead: l.id })}>
                    {t("open")}
                  </Button>
                )}
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
              value={stage}
              onChange={(v) => setF({ stage: v })}
              tabs={STAGES.map((v) => ({ value: v, label: <>{t(`stage.${v}`)} {s && <span className="tab-count">{fmt.num(s.stages[v].n)}</span>}</> }))}
            />
          }
        >
          <div style={{ width: 220, flexShrink: 1, minWidth: 160 }}>
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
          <Empty title={filtered ? t("empty.filtered") : t("empty.any")} onClearFilters={filtered ? () => (setQuery(""), setF({ ...filterKeys(defs), q: "" })) : undefined} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.company")}</th>
                    <th scope="col">{t("col.source")}</th>
                    <th scope="col" className="num">
                      {t("col.seats")}
                    </th>
                    <th scope="col" className="num">
                      {t("col.value")}
                    </th>
                    <th scope="col">{closed ? t("col.closed") : t("col.next")}</th>
                    <th scope="col">{t("col.owner")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((l, i) => (
                    <tr key={l.id} className="row-link" aria-selected={f.lead === l.id} onClick={() => setF({ lead: l.id })} {...nav.rowProps(i)}>
                      <td>
                        <span className="cell-strong">{l.company}</span>
                        {l.contactName && <div className="cell-sub">{l.contactName}</div>}
                      </td>
                      <td>{t(`source.${l.source}`)}</td>
                      <td className="num">{l.seats != null ? fmt.num(l.seats) : "—"}</td>
                      <td className="num">{l.valueSatang != null ? fmt.money(l.valueSatang) : "—"}</td>
                      <td className="small">
                        {closed ? (
                          <>
                            {fmt.date(l.closedAt)}
                            {l.lostReason && <div className="cell-sub">{t(`lostReason.${l.lostReason}` as "lostReason.price")}</div>}
                          </>
                        ) : (
                          <>
                            {l.nextAction ?? "—"}
                            {l.nextAt && <div className="cell-sub">{fmt.date(l.nextAt)}</div>}
                          </>
                        )}
                      </td>
                      <td className="small">{l.owner ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={items.length} total={list.data.total} onChange={setOffset} hotkeys />
          </>
        )}
      </section>
      {f.lead && <LeadDrawer key={f.lead} id={f.lead} onClose={() => setF({ lead: "" })} />}
      {adding && <AddLead onClose={() => setAdding(false)} onAdded={(id) => setF({ lead: id, stage: "new" })} />}
    </>
  );
}

function AddLead({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const t = useTranslations("leads.form");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [f, setF] = useState({ company: "", contactName: "", email: "", phone: "", seats: "", value: "", nextAction: "", nextAt: new Date(Date.now() + 31 * 3_600_000).toISOString().slice(0, 10) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/leads", {
        company: f.company.trim(), nextAction: f.nextAction.trim(), nextAt: f.nextAt,
        ...(f.contactName.trim() ? { contactName: f.contactName.trim() } : {}),
        ...(f.email.trim() ? { email: f.email.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.seats ? { seats: Number(f.seats) } : {}),
        ...(f.value ? { valueSatang: Math.round(Number(f.value) * 100) } : {}),
      }),
    onSuccess: (r) => (toast(t("saved")), void cache.invalidateQueries({ queryKey: LEADS_KEY }), onClose(), onAdded(r.id)),
  });
  const ok = f.company.trim().length >= 2 && f.nextAction.trim().length >= 2 && !!f.nextAt && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("company")} value={f.company} onChange={set("company")} />
        <div className="row">
          <Input label={t("contact")} value={f.contactName} onChange={set("contactName")} />
          <Input label={t("email")} type="email" value={f.email} onChange={set("email")} />
        </div>
        <div className="row">
          <Input label={t("phone")} value={f.phone} onChange={set("phone")} />
          <Input label={t("seats")} type="number" min={1} value={f.seats} onChange={set("seats")} />
          <Input label={t("value")} type="number" min={0} value={f.value} onChange={set("value")} />
        </div>
        <div className="row">
          <Input label={t("nextAction")} value={f.nextAction} onChange={set("nextAction")} />
          <Input label={t("nextAt")} type="date" value={f.nextAt} onChange={set("nextAt")} />
        </div>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LeadSettingsPanel() {
  const t = useTranslations("leads.settings");
  const toast = useToast();
  const q = useQuery({ queryKey: [...LEADS_KEY, "settings"], queryFn: () => api.get<{ trialSeats: number }>("/leads/settings") });
  const [v, setV] = useState<string | null>(null);
  const m = useMutation({ mutationFn: () => api.put("/leads/settings", { trialSeats: Number(v) }), onSuccess: () => toast(t("saved")) });
  if (!q.data) return <TableSkeleton rows={1} cols={2} />;
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), v && Number(v) >= 1 && m.mutate())}>
      <Input label={t("trialSeats")} type="number" min={1} value={v ?? String(q.data.trialSeats)} onChange={(e) => setV(e.target.value)} />
      <InlineError error={m.error} />
      <div className="dialog-actions">
        <Button type="submit" variant="primary" disabled={!v || m.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
