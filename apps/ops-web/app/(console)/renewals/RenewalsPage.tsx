"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { seesMoney } from "@/components/access";
import { Empty, ErrorBlock, ListBar, PageHead, Pager, TableSkeleton } from "@/components/kit";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useRowNav } from "@/lib/shortcuts";
import { useUrlFilters } from "@/lib/url-state";
import { healthTone, useFmt } from "../workspaces/_parts/format";
import { type Account, ACCOUNTS_KEY } from "../accounts/_parts/types";

const PAGE = 50;
const WITHIN = ["30", "60", "90", "180", "365"] as const;

/** เมนู "วันต่อสัญญา" (ช่วง 3) · บัญชีที่สัญญาจะหมด (รวมที่เพิ่งหมดไม่เกิน 30 วัน) เรียงใกล้หมดก่อน · Support ไม่เห็นมูลค่า */
export function RenewalsPage() {
  const t = useTranslations("customers.renewals");
  const ta = useTranslations("customers.accounts.col");
  const fmt = useFmt();
  const router = useRouter();
  const money = seesMoney(useMe().data);
  const [f, setF] = useUrlFilters({ within: "90", page: "0" });
  const offset = Number(f.page) * PAGE || 0;
  const qs = new URLSearchParams({ within: f.within, limit: String(PAGE), offset: String(offset) });
  const q = useQuery({ queryKey: [...ACCOUNTS_KEY, "renewals", qs.toString()], queryFn: () => api.get<{ items: Account[]; total: number }>(`/renewals?${qs}`), placeholderData: keepPreviousData });
  const rows = q.data?.items ?? [];
  const tk = useTranslations("common.keys");
  const nav = useRowNav(rows, { onOpen: (a) => router.push(`/accounts/${a.id}`), labels: { down: tk("down"), open: tk("open") } });
  const left = (d: number) => (d < 0 ? t("expired", { n: -d }) : d === 0 ? t("today") : t("left", { n: d }));
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      <ListBar>
        <label className="row small muted">
          {t("within")}
          <select className="input" style={{ width: "auto" }} value={f.within} onChange={(e) => setF({ within: e.target.value, page: "0" })}>
            {WITHIN.map((n) => (
              <option key={n} value={n}>
                {t("days", { n })}
              </option>
            ))}
          </select>
        </label>
      </ListBar>
      {q.isPending ? (
        <TableSkeleton rows={5} cols={7} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !rows.length ? (
        <Empty ok title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{ta("name")}</th>
                <th scope="col">{ta("contractEnd")}</th>
                {money && (
                  <th scope="col" className="num">
                    {ta("value")}
                  </th>
                )}
                <th scope="col" className="num">
                  {ta("seats")}
                </th>
                <th scope="col">{ta("health")}</th>
                <th scope="col">{ta("manager")}</th>
                <th scope="col">{ta("lastContact")}</th>
              </tr>
            </thead>
            <tbody className="motion-list">
              {rows.map((a, i) => (
                <tr key={a.id} className="row-link" onClick={() => router.push(`/accounts/${a.id}`)} {...nav.rowProps(i)}>
                  <td>
                    <Link href={`/accounts/${a.id}`} className="row-link-button" onClick={(e) => e.stopPropagation()}>
                      <b>{a.name}</b>
                    </Link>
                    <div className="cell-sub">{a.numbers.workspaces} Workspace</div>
                  </td>
                  <td>
                    {fmt.date(a.contractEnd)} <span className={`pill ${(a.daysLeft ?? 0) <= 30 ? "bad" : (a.daysLeft ?? 0) <= 60 ? "warn" : "neu"}`}>{left(a.daysLeft ?? 0)}</span>
                  </td>
                  {money && <td className="num">{fmt.money(a.contractValue)}</td>}
                  <td className="num">{t("seatsUse", { used: a.numbers.seats, limit: a.contractSeats ?? (a.numbers.seatLimit || "∞") })}</td>
                  <td>{a.numbers.minHealth ? <span className={`pill ${healthTone(a.numbers.minHealth.score)}`}>{a.numbers.minHealth.score}</span> : "—"}</td>
                  <td className={a.managerName ? undefined : "muted"}>{a.managerName ?? "—"}</td>
                  <td className="muted">{fmt.ago(a.lastContactAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data?.total != null && <Pager offset={offset} limit={PAGE} shown={rows.length} total={q.data.total} onChange={(o) => setF({ page: String(Math.floor(o / PAGE)) })} />}
    </>
  );
}
