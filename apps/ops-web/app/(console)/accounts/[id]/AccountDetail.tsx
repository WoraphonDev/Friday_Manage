"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useRef, useState } from "react";
import { seesMoney } from "@/components/access";
import { ConfirmDialog } from "@/components/dialogs";
import { ErrorBlock, PageHead, Pager, TableSkeleton } from "@/components/kit";
import { Button, errorToast, Input, LoadingState, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { defer, UNDO_MS } from "@/lib/outbox";
import { useMe } from "@/lib/query";
import { healthTone, planLabel, useFmt } from "../../workspaces/_parts/format";
import { AddWorkspacesDialog, ContractDialog, EditAccountDialog } from "../_parts/Dialogs";
import { type Account, ACCOUNTS_KEY, type Dur } from "../_parts/types";

const PAGE = 20;
interface WsRow {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  seats: number;
  seatLimit: number | null;
  health: number;
  mrr: number | null;
  openTickets: number;
}

/** หน้าบัญชีลูกค้า (ช่วง 3) · ตัวเลขรวมทุก Workspace · สุขภาพต่ำสุดคือตัวที่ต้องดู · ตาราง Workspace ค้นและแบ่งหน้าที่ ops-api */
export function AccountDetail({ id }: { id: string }) {
  const t = useTranslations("customers.accounts.detail");
  const ta = useTranslations("customers.accounts");
  const fmt = useFmt();
  const me = useMe().data;
  const money = seesMoney(me);
  const router = useRouter();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: [...ACCOUNTS_KEY, "detail", id], queryFn: () => api.get<Account>(`/accounts/${id}`) });
  const [dialog, setDialog] = useState<"edit" | "contract" | "add" | "delete" | null>(null);
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const [offset, setOffset] = useState(0);
  const [hiddenWs, setHiddenWs] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const qs = new URLSearchParams({ account: id, limit: String(PAGE), offset: String(offset), sort: "newest", test: "all", ...(term ? { q: term } : {}) });
  const ws = useQuery({ queryKey: ["ops", "workspaces", "account", qs.toString()], queryFn: () => api.get<{ items: WsRow[]; total: number }>(`/workspaces?${qs}`), placeholderData: keepPreviousData });
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void cache.invalidateQueries({ queryKey: ["ops", "workspaces"] });
  };
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const a = q.data;
  const n = a.numbers;
  const dur = (d: Dur | null) => (d ? `${d.n} ${d.unit === "h" ? "ชม." : "วัน"}` : "—");
  // เอาออกจากบัญชี: ย้อนได้ 10 วินาที (ไม่ถึงลูกค้า)
  const unlink = (w: WsRow) => {
    setHiddenWs((x) => [...x, w.id]);
    const job = defer(
      `account-unlink:${w.id}`,
      () => api.delete(`/accounts/${a.id}/workspaces/${w.id}`).then(refresh),
      (e) => (setHiddenWs((x) => x.filter((y) => y !== w.id)), toast(errorToast(e))),
    );
    toast({ message: t("removed", { name: w.name }), duration: UNDO_MS, undo: () => job.cancel() && setHiddenWs((x) => x.filter((y) => y !== w.id)) });
  };
  const upload = async (file: File) => {
    try {
      const res = await fetch(`${OPS_BASE}/accounts/${a.id}/contract-file`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, body: file });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? res.statusText);
      refresh();
      toast(t("uploaded"));
    } catch (e) {
      toast(errorToast(e));
    }
  };
  const rows = (ws.data?.items ?? []).filter((w) => !hiddenWs.includes(w.id));
  return (
    <>
      <PageHead
        title={a.name}
        desc={
          <>
            {a.taxIds[0] ? t("tax", { tax: a.taxIds[0] }) : ""}
            {a.taxIds.length > 1 ? ` ${t("taxMore", { n: a.taxIds.length - 1 })}` : ""}
            {" · "}
            {a.managerName ? t("manager", { name: a.managerName }) : t("noManager")}
            {a.contractEnd ? ` · ${t("renew", { date: fmt.date(a.contractEnd) })}` : ""} · {ta(`kind.${a.kind}`)}
          </>
        }
        actions={
          <>
            {a.can?.edit && <Button onClick={() => setDialog("add")}>{t("add")}</Button>}
            {a.can?.contract && <Button onClick={() => setDialog("contract")}>{t("contract")}</Button>}
            {a.can?.edit && (
              <Button variant="primary" onClick={() => setDialog("edit")}>
                {t("edit")}
              </Button>
            )}
          </>
        }
      />
      <section className="stats" aria-label={t("numbers")}>
        <div className="stat">
          <span className="muted small">{t("workspaces")}</span>
          <b className="num">{n.workspaces}</b>
        </div>
        <div className="stat">
          <span className="muted small">{t("seats")}</span>
          <b className="num">{t("seatsOf", { used: n.seats, limit: a.contractSeats ?? (n.seatLimit || "∞") })}</b>
        </div>
        {money && (
          <div className="stat">
            <span className="muted small">{t("mrr")}</span>
            <b className="num">{fmt.money(n.mrr)}</b>
          </div>
        )}
        <div className={n.minHealth && n.minHealth.score < 40 ? "stat stat-bad" : "stat"}>
          <span className="muted small">{t("minHealth")}</span>
          <b className="num">{n.minHealth?.score ?? "—"}</b>
          {n.minHealth && (
            <Link className="muted small" href={`/workspaces/${n.minHealth.workspace.id}`}>
              {t("minHealthNote", { name: n.minHealth.workspace.name })}
            </Link>
          )}
        </div>
        <div className="stat">
          <span className="muted small">{t("tickets")}</span>
          <b className="num">{n.openTickets}</b>
          {n.openTickets > 0 && (
            <Link className="muted small" href={`/support?tab=all&account=${a.id}`}>
              Ticket
            </Link>
          )}
        </div>
        {money && (
          <div className={n.overdue ? "stat stat-bad" : "stat"}>
            <span className="muted small">{t("overdue")}</span>
            <b className="num">{fmt.money(n.overdue)}</b>
          </div>
        )}
        <div className="stat">
          <span className="muted small">{t("active30")}</span>
          <b className="num">{n.active30}</b>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("wsTitle")}</h2>
          <span className="spacer" />
          <Input type="search" aria-label={t("wsSearch")} placeholder={t("wsSearch")} value={search} onChange={(e) => (setSearch(e.target.value), setOffset(0))} />
        </div>
        {ws.isPending ? (
          <TableSkeleton rows={3} cols={5} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Workspace</th>
                  <th scope="col">{t("colPlan")}</th>
                  <th scope="col" className="num">
                    {t("seats")}
                  </th>
                  <th scope="col">{t("colHealth")}</th>
                  {money && (
                    <th scope="col" className="num">
                      MRR
                    </th>
                  )}
                  <th scope="col" className="num">
                    {t("tickets")}
                  </th>
                  {a.can?.edit && <th scope="col" aria-label={t("remove")} />}
                </tr>
              </thead>
              <tbody className="motion-list">
                {rows.map((w) => (
                  <tr key={w.id} className="row-link" onClick={() => router.push(`/workspaces/${w.id}`)}>
                    <td>
                      <b>{w.name}</b>
                      <div className="cell-sub">{w.slug}</div>
                    </td>
                    <td>{planLabel(w.plan)}</td>
                    <td className="num">
                      {w.seats} / {w.seatLimit ?? "∞"}
                    </td>
                    <td>
                      <span className={`pill ${healthTone(w.health)}`}>{w.health}</span>
                    </td>
                    {money && <td className="num">{fmt.money(w.mrr)}</td>}
                    <td className="num">{w.openTickets}</td>
                    {a.can?.edit && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="link-button small" aria-label={t("removeAsk", { name: w.name })} onClick={() => unlink(w)}>
                          {t("remove")}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ws.data && <Pager offset={offset} limit={PAGE} shown={ws.data.items.length} total={ws.data.total} onChange={setOffset} />}
      </section>
      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">{t("contractTitle")}</h2>
          {a.contractEnd || a.contractSla ? (
            <ul className="stack small" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
              {a.contractEnd && <li>{t("period", { start: fmt.date(a.contractStart), end: fmt.date(a.contractEnd) })}</li>}
              {money && a.contractValue != null && <li>{t("valueYear", { value: fmt.money(a.contractValue) })}</li>}
              {a.contractSeats != null && <li>{t("contractSeats", { n: a.contractSeats })}</li>}
              {a.contractSla && <li>{t("sla", { first: dur(a.contractSla.first), resolve: dur(a.contractSla.resolve) })}</li>}
            </ul>
          ) : (
            <p className="muted small">{t("noContract")}</p>
          )}
          <div className="row small" style={{ marginTop: 8 }}>
            <span className="muted">{t("file")}:</span>
            {a.file ? (
              money ? (
                <a className="link-button" href={`${OPS_BASE}/accounts/${a.id}/contract-file`} target="_blank" rel="noreferrer">
                  {a.file.name}
                </a>
              ) : (
                <span>{a.file.name}</span>
              )
            ) : (
              <span className="muted">{t("noFile")}</span>
            )}
            {a.can?.contract && (
              <>
                <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
                <Button size="small" onClick={() => fileInput.current?.click()}>
                  {t("upload")}
                </Button>
              </>
            )}
          </div>
          {a.lastContactAt && <p className="muted small">{t("lastContact", { when: fmt.ago(a.lastContactAt) })}</p>}
        </section>
        <section className="card">
          <h2 className="card-title">{t("contacts")}</h2>
          {a.contacts?.length ? (
            <ul className="stack small" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
              {a.contacts.map((c, i) => (
                <li key={i}>
                  <b>{c.name}</b> · {ta(`contactRole.${c.role}`)}
                  {c.email ? ` · ${c.email}` : ""}
                  {c.phone ? ` · ${c.phone}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t("noContacts")}</p>
          )}
          <h3 className="field-label" style={{ marginTop: 12 }}>
            {t("notes")}
          </h3>
          <p className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {a.notes || <span className="muted">{t("noNotes")}</span>}
          </p>
          {a.can?.remove && (
            <div style={{ marginTop: 12 }}>
              <Button size="small" variant="ghost" onClick={() => setDialog("delete")}>
                {t("delete")}
              </Button>
            </div>
          )}
        </section>
      </div>
      {dialog === "edit" && <EditAccountDialog account={a} onClose={() => setDialog(null)} />}
      {dialog === "contract" && <ContractDialog account={a} onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddWorkspacesDialog account={a} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("deleteTitle", { name: a.name })}
        description={t("deleteDesc")}
        confirmLabel={t("delete")}
        danger
        minReason={0}
        onConfirm={() => api.delete(`/accounts/${a.id}`).then(() => (refresh(), toast(t("deleted")), router.push("/accounts")))}
      />
    </>
  );
}
