"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { useApprovalFlow } from "@/components/dialogs";
import { Empty, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Pill, Textarea, type Tone, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { planLabel, useFmt } from "./format";

/** O41 · R1 บัญชีเครดิตของลูกค้า (GET ops/credits) */
interface Ledger {
  balanceSatang: number;
  items: {
    id: string;
    at: string;
    amountSatang: number;
    balanceSatang: number;
    source: "credit_note" | "overpayment" | "goodwill" | "applied" | "refunded" | "reversal";
    note: string | null;
    invoice: { id: string; number: string | null } | null;
    creditNote: { id: string; number: string | null } | null;
    staff: string | null;
  }[];
  next: { date: string; plan: string; totalSatang: number; creditSatang: number; payableSatang: number } | null;
}

const TONE: Record<Ledger["items"][number]["source"], Tone> = { credit_note: "inf", overpayment: "ok", goodwill: "ok", applied: "neu", refunded: "warn", reversal: "neu" };

/** บาท 2 ตำแหน่ง (เครดิตมีเศษสตางค์ · format.money ปัดเป็นบาท) */
const baht = (satang: number) => (satang / 100).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** CSV ประวัติเครดิต (มี BOM ให้ Excel อ่านภาษาไทยได้) */
function downloadCsv(name: string, d: Ledger, label: (s: Ledger["items"][number]["source"]) => string) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [["date", "source", "item", "amount_baht", "balance_baht"], ...d.items.map((i) => [i.at, label(i.source), [i.note, i.invoice?.number, i.creditNote?.number].filter(Boolean).join(" · "), (i.amountSatang / 100).toFixed(2), (i.balanceSatang / 100).toFixed(2)])];
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `credit-${name}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

export function CreditCard({ id, name }: { id: string; name: string }) {
  const t = useTranslations("customers.credit");
  const fmt = useFmt();
  const me = useMe().data;
  const finance = hasAny(me, "finance");
  const [dialog, setDialog] = useState<"add" | "refund" | null>(null);
  const q = useQuery({ queryKey: ["ops", "credits", id], queryFn: () => api.get<Ledger>(`/credits?workspaceId=${id}`) });
  const label = (s: Ledger["items"][number]["source"]) => t(`sources.${s}`);
  return (
    <div className="grid-credit">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("title")}</h2>
          {q.data && <span className="card-sub">{t("balance", { amount: `฿${baht(q.data.balanceSatang)}` })}</span>}
          <span className="spacer" />
          {q.data && q.data.items.length > 0 && (
            <Button size="small" onClick={() => downloadCsv(name, q.data, label)}>
              {t("csv")}
            </Button>
          )}
          {finance && (
            <>
              <Button size="small" disabled={!q.data?.balanceSatang} onClick={() => setDialog("refund")}>
                {t("refund")}
              </Button>
              <Button size="small" variant="primary" onClick={() => setDialog("add")}>
                {t("add")}
              </Button>
            </>
          )}
        </div>
        {q.isPending ? (
          <TableSkeleton cols={5} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <Empty title={t("empty")} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl" aria-label={t("title")}>
              <thead>
                <tr>
                  <th>{t("col.date")}</th>
                  <th>{t("col.item")}</th>
                  <th>{t("col.source")}</th>
                  <th className="num">{t("col.amount")}</th>
                  <th className="num">{t("col.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap">{fmt.date(i.at)}</td>
                    <td>
                      {i.source === "applied" && i.invoice ? t("usedFor", { invoice: i.invoice.number ?? "" }) : i.note}
                      <div className="cell-sub">
                        {[i.creditNote?.number, i.source !== "applied" ? i.invoice?.number : null, i.staff ? t("byStaff", { name: i.staff }) : null].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td>
                      <Pill tone={TONE[i.source]}>{label(i.source)}</Pill>
                    </td>
                    <td className="num">{i.amountSatang > 0 ? `+${baht(i.amountSatang)}` : `−${baht(-i.amountSatang)}`}</td>
                    <td className="num">{baht(i.balanceSatang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t("summary")}</h2>
        </div>
        {q.data && (
          <table className="tbl">
            <tbody>
              <tr>
                <td className="muted">{t("sBalance")}</td>
                <td className="num cell-main">฿{baht(q.data.balanceSatang)}</td>
              </tr>
              <tr>
                <td className="muted">{t("sNext")}</td>
                <td>{q.data.next ? t("sNextValue", { date: fmt.date(q.data.next.date), plan: planLabel(q.data.next.plan), amount: `฿${baht(q.data.next.totalSatang)}` }) : t("sNone")}</td>
              </tr>
              <tr>
                <td className="muted">{t("sPayable")}</td>
                <td className="num cell-main">{q.data.next ? `฿${baht(q.data.next.payableSatang)}` : t("sNone")}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="muted small">{t("note")}</p>
      </section>
      {dialog && q.data && <CreditDialog kind={dialog} id={id} name={name} balance={q.data.balanceSatang} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** เพิ่มเครดิต (POST ops/credits · เกินวงเงินขออนุมัติ) / คืนเครดิตเป็นเงิน (POST ops/credits:refund) */
function CreditDialog({ kind, id, name, balance, onClose }: { kind: "add" | "refund"; id: string; name: string; balance: number; onClose: () => void }) {
  const t = useTranslations("customers.credit");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const limits = useMe().data?.limits;
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [amount, setAmount] = useState(kind === "refund" ? String(balance / 100) : "");
  const [reason, setReason] = useState("");
  const satang = Math.round(Number(amount) * 100);
  const ok = satang > 0 && (kind === "add" || satang <= balance) && reason.trim().length >= 3;
  const m = useMutation({
    mutationFn: () => api.post<{ pendingApproval?: unknown }>(kind === "add" ? "/credits" : "/credits:refund", { workspaceId: id, amountSatang: satang, reason: reason.trim() }),
    onSuccess: (r) => {
      onClose();
      if (r?.pendingApproval) handle(r);
      else toast(t(kind === "add" ? "added" : "refunded"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t(kind === "add" ? "addTitle" : "refundTitle", { name })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("amountLabel")} type="number" min={0.01} step={0.01} max={kind === "refund" ? balance / 100 : undefined} value={amount} onChange={(e) => setAmount(e.target.value)} />
        {kind === "refund" && <p className="muted small">{t("max", { amount: `฿${baht(balance)}` })}</p>}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        {limits && <p className="muted small">{kind === "add" ? t("addHint", { limit: fmt.money(limits.creditSatang) }) : t("refundHint", { limit: fmt.money(limits.refundSatang) })}</p>}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {m.isPending ? tc("saving") : t(kind === "add" ? "submitAdd" : "submitRefund")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
