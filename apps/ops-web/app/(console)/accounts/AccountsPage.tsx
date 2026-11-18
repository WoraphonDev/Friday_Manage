"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useEffect, useState } from "react";
import { hasAny, seesMoney } from "@/components/access";
import { ActiveFilters, FilterButton, type FilterDef, filterKeys, filterQuery } from "@/components/filters";
import { Empty, ErrorBlock, ListBar, Notice, PageHead, Pager, TableSkeleton } from "@/components/kit";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useSupportStaff } from "@/lib/staff-options";
import { useUrlFilters } from "@/lib/url-state";
import { healthTone, useFmt } from "../workspaces/_parts/format";
import { CreateAccountDialog } from "./_parts/CreateAccount";
import { type Account, ACCOUNTS_KEY, type Suggestion } from "./_parts/types";

const PAGE = 50;

/** เมนู "บัญชีลูกค้า" (ช่วง 3) · ค้นชื่อ / เลขภาษี · กรองผู้ดูแล ประเภท สุขภาพ วันต่อสัญญา ค้างชำระ · แบ่งหน้าที่ ops-api */
export function AccountsPage() {
  const t = useTranslations("customers.accounts");
  const fmt = useFmt();
  const router = useRouter();
  const me = useMe().data;
  const money = seesMoney(me);
  const canCreate = hasAny(me, "owner", "support");
  const staff = useSupportStaff();
  const defs: FilterDef[] = [
    { key: "manager", label: t("f.manager"), kind: "single", options: [{ value: "none", label: t("f.noManager") }, ...staff] },
    { key: "kind", label: t("f.kind"), kind: "single", options: (["standard", "enterprise"] as const).map((k) => ({ value: k, label: t(`kind.${k}`) })) },
    { key: "health", label: t("f.health"), kind: "single", options: [{ value: "low", label: t("f.healthLow") }] },
    { key: "renew", label: t("f.renew"), kind: "single", options: ["30", "60", "90"].map((n) => ({ value: n, label: t("f.days", { n }) })) },
    { key: "overdue", label: t("f.overdue"), kind: "single", options: [{ value: "yes", label: t("f.overdueYes") }] },
  ];
  const defaults = { q: "", page: "0", ...filterKeys(defs) };
  const [f, setF] = useUrlFilters(defaults);
  const fq = filterQuery(defs, f);
  const setFilters = (patch: Record<string, string>) => setF({ ...patch, page: "0" });
  const [q, setQ] = useState(f.q);
  const search = useDeferredValue(q.trim());
  useEffect(() => {
    if (search !== f.q) setF({ q: search, page: "0" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const offset = Number(f.page) * PAGE || 0;
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { q: search } : {}), ...fq });
  const list = useQuery({ queryKey: [...ACCOUNTS_KEY, "list", qs.toString()], queryFn: () => api.get<{ items: Account[]; total: number }>(`/accounts?${qs}`), placeholderData: keepPreviousData });
  const suggest = useQuery({ queryKey: [...ACCOUNTS_KEY, "suggestions"], queryFn: () => api.get<{ items: Suggestion[] }>("/accounts/suggestions"), enabled: hasAny(me, "owner", "support", "finance", "auditor") });
  const [making, setMaking] = useState<Suggestion | null>(null);
  const rows = list.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(rows, { onOpen: (a) => router.push(`/accounts/${a.id}`), labels: { down: tk("down"), open: tk("open") } });
  const filtered = !!search || Object.keys(fq).length > 0;
  const sug = suggest.data?.items ?? [];
  return (
    <>
      <PageHead title={t("title")} desc={list.data ? t("summary", { total: list.data.total }) : t("desc")} />
      {sug.length > 0 && (
        <Notice tone="info" title={t("suggest.title", { n: sug.length })}>
          <p className="muted small" style={{ margin: "0 0 6px" }}>
            {t("suggest.desc")}
          </p>
          <ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
            {sug.slice(0, 5).map((s) => (
              <li key={s.key} className="row" style={{ gap: 8 }}>
                <Link className="link-button" href={`/workspaces?buyer=${encodeURIComponent(s.key)}`}>
                  {t("suggest.row", { name: s.name ?? s.taxId, tax: s.taxId, n: s.count })}
                </Link>
                {canCreate && (
                  <Button size="small" onClick={() => setMaking(s)}>
                    {t("suggest.create")}
                  </Button>
                )}
              </li>
            ))}
            {sug.length > 5 && <li className="muted small">{t("suggest.more", { n: sug.length - 5 })}</li>}
          </ul>
        </Notice>
      )}
      <ListBar>
        {/* ข้อความในช่องยาว (ชื่อ เลขภาษี Workspace) · หน้านี้ไม่มีแท็บ จึงให้ช่องกว้างกว่าหน้าอื่น */}
        <div style={{ width: "min(400px, 100%)" }}>
          <Input data-page-search aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <FilterButton defs={defs} values={f} onChange={setFilters} />
      </ListBar>
      <ActiveFilters defs={defs} values={f} onChange={setFilters} />
      {list.isPending ? (
        <TableSkeleton rows={6} cols={7} />
      ) : list.error ? (
        <ErrorBlock error={list.error} retry={() => void list.refetch()} />
      ) : !rows.length ? (
        <Empty title={filtered ? t("emptyFiltered") : t("empty")} description={filtered ? undefined : t("emptyDesc")} onClearFilters={filtered ? () => (setQ(""), setF({ ...defaults })) : undefined} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.name")}</th>
                <th scope="col" className="num">
                  {t("col.workspaces")}
                </th>
                <th scope="col" className="num">
                  {t("col.seats")}
                </th>
                {money && (
                  <th scope="col" className="num">
                    {t("col.mrr")}
                  </th>
                )}
                <th scope="col">{t("col.health")}</th>
                <th scope="col" className="num">
                  {t("col.tickets")}
                </th>
                <th scope="col">{t("col.manager")}</th>
                <th scope="col">{t("col.contractEnd")}</th>
              </tr>
            </thead>
            <tbody className="motion-list">
              {rows.map((a, i) => (
                <tr key={a.id} className="row-link" onClick={() => router.push(`/accounts/${a.id}`)} {...nav.rowProps(i)}>
                  <td>
                    <Link href={`/accounts/${a.id}`} className="row-link-button" onClick={(e) => e.stopPropagation()}>
                      <b>{a.name}</b>
                    </Link>
                    <div className="cell-sub">
                      {t(`kind.${a.kind}`)}
                      {a.taxIds[0] ? ` · ${a.taxIds[0]}` : ""}
                      {a.numbers.overdueAny && <span className="pill bad"> {t("col.overdue")}</span>}
                    </div>
                  </td>
                  <td className="num">{a.numbers.workspaces}</td>
                  <td className="num">
                    {a.numbers.seats} / {a.contractSeats ?? (a.numbers.seatLimit || "∞")}
                  </td>
                  {money && <td className="num">{fmt.money(a.numbers.mrr)}</td>}
                  <td>
                    {a.numbers.minHealth ? (
                      <>
                        <span className={`pill ${healthTone(a.numbers.minHealth.score)}`}>{a.numbers.minHealth.score}</span> <span className="muted small">{a.numbers.minHealth.workspace.name}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">{a.numbers.openTickets}</td>
                  <td className={a.managerName ? undefined : "muted"}>{a.managerName ?? "—"}</td>
                  <td>{fmt.date(a.contractEnd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.total != null && <Pager hotkeys offset={offset} limit={PAGE} shown={rows.length} total={list.data.total} onChange={(o) => setF({ page: String(Math.floor(o / PAGE)) })} />}
      {making && <CreateAccountDialog name={making.name ?? ""} taxIds={[making.taxId]} workspaces={making.workspaces} onClose={() => setMaking(null)} />}
    </>
  );
}
