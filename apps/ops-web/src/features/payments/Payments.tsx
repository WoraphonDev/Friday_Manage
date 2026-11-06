"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, buttonClass, Dialog, EmptyState, ErrorState, InlineError, Input, LoadingState, Pill, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { formatBaht, formatDateTime } from "@/lib/format";
import { keys } from "@/lib/query";
import type { PaymentRow } from "@/lib/types";
import { PageHeader } from "../shell/Shell";

type Status = PaymentRow["status"];
type Item = { kind: "slip"; p: PaymentRow } | { kind: "wht"; p: PaymentRow; cert: PaymentRow["whtCertificates"][number] };

export function Payments() {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [status, setStatus] = useState<Status>("pending_review");
  const [rejecting, setRejecting] = useState<Item | null>(null);
  // ผลการตัดสินแสดงในแถวเดิมแบบ Canvas (ไม่ให้แถวหายทันทีหลังกด)
  const [results, setResults] = useState<Record<string, { label: string; ok: boolean }>>({});
  const q = useQuery({ queryKey: keys.payments(status), queryFn: () => api.get<{ items: PaymentRow[] }>(`/payments?status=${status}`) });
  const done = (id: string, label: string, ok: boolean) => {
    setResults((r) => ({ ...r, [id]: { label, ok } }));
    void cache.invalidateQueries({ queryKey: keys.metrics });
  };
  const confirm = useMutation({
    mutationFn: (item: Item) => (item.kind === "slip" ? api.post(`/payments/${item.p.id}/confirm`) : api.post(`/wht-certificates/${item.cert.id}/confirm`)),
    onSuccess: (_r, item) => done(item.kind === "slip" ? item.p.id : item.cert.id, item.kind === "slip" ? t("pay.approved") : t("pay.accepted"), true),
    onError: (e) => toast(e.message),
  });

  const items: Item[] = (q.data?.items ?? []).flatMap((p) => [
    { kind: "slip" as const, p },
    ...p.whtCertificates.filter((c) => (status === "pending_review" ? c.status === "pending_review" : true)).map((cert) => ({ kind: "wht" as const, p, cert })),
  ]);

  return (
    <>
      <PageHeader title={t("titles.payments")} desc={t("titles.paymentsDesc")} />
      <section className="card">
        <div className="ch">
          <h2>{status === "pending_review" ? t("pay.title") : t("pay.titleOther")}</h2>
          <span className="muted small-13 grow-200">{t("pay.sla")}</span>
          <select className="input select auto" aria-label={t("pay.status")} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {(["pending_review", "confirmed", "rejected"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`pay.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {q.isPending ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title={t("pay.empty")} description={t("pay.emptyDesc")} />
        ) : (
          items.map((item) => {
            const { p } = item;
            const id = item.kind === "slip" ? p.id : item.cert.id;
            const rowStatus = item.kind === "slip" ? p.status : item.cert.status;
            const result = results[id];
            const file = item.kind === "slip" ? (p.hasSlip ? `${OPS_BASE}/payments/${p.id}/slip` : null) : `${OPS_BASE}/wht-certificates/${item.cert.id}/file`;
            const desc =
              item.kind === "slip"
                ? t("pay.slipDesc", { method: t(`methods.${p.method}`), total: formatBaht(p.invoice.total) }) +
                  (p.invoice.whtAmount ? t("pay.whtPart", { amount: formatBaht(p.invoice.whtAmount) }) : "") +
                  (p.amount !== p.invoice.amountDue ? t("pay.mismatch", { due: formatBaht(p.invoice.amountDue) }) : "")
                : t("pay.whtDesc", { amount: formatBaht(p.invoice.whtAmount) });
            return (
              <div className="pr" key={`${item.kind}-${id}`} data-testid={`${item.kind}-${id}`}>
                <Pill tone={item.kind === "slip" ? "neu" : "inf"}>{item.kind === "slip" ? t("pay.slip") : t("pay.wht")}</Pill>
                <div className="grow-260">
                  <b>{p.workspace.name}</b> <span className="muted mono">{p.invoice.number}</span>
                  <div className="muted small">
                    {desc} · {formatDateTime(item.kind === "slip" ? p.createdAt : item.cert.createdAt)}
                  </div>
                </div>
                <b className="nowrap">{formatBaht(item.kind === "slip" ? p.amount : p.invoice.whtAmount)}</b>
                {result ? (
                  <Pill tone={result.ok ? "ok" : "bad"}>{result.label}</Pill>
                ) : rowStatus === "pending_review" ? (
                  <span className="row-6">
                    {file ? (
                      <a className={buttonClass()} href={file} target="_blank" rel="noopener">
                        {t("ui.viewFile")}
                      </a>
                    ) : (
                      <span className="muted small">{t("pay.noFile")}</span>
                    )}
                    <Button onClick={() => setRejecting(item)}>{t("pay.reject")}</Button>
                    <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate(item)}>
                      {item.kind === "slip" ? t("pay.approve") : t("pay.accept")}
                    </Button>
                  </span>
                ) : (
                  <Pill tone={rowStatus === "confirmed" ? "ok" : "bad"}>{t(`pay.${rowStatus}`)}</Pill>
                )}
              </div>
            );
          })
        )}
      </section>
      {rejecting && (
        <RejectDialog
          item={rejecting}
          onClose={() => setRejecting(null)}
          onDone={(revoked) => {
            done(rejecting.kind === "slip" ? rejecting.p.id : rejecting.cert.id, revoked ? t("pay.revoked") : t("pay.rejectedResult"), false);
            setRejecting(null);
          }}
        />
      )}
    </>
  );
}

function RejectDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: (revoked: boolean) => void }) {
  const t = useTranslations("ops");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const reject = useMutation({
    mutationFn: () => (item.kind === "slip" ? api.post<{ revoked?: boolean }>(`/payments/${item.p.id}/reject`, { reason: reason.trim() }) : api.post<{ revoked?: boolean }>(`/wht-certificates/${item.cert.id}/reject`, { reason: reason.trim() })),
    onSuccess: (r) => onDone(!!r.revoked),
  });
  const short = reason.trim().length < 3;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t("pay.rejectTitle", { what: `${item.kind === "slip" ? t("pay.slip") : t("pay.wht")} ${item.p.invoice.number}` })} description={t("pay.rejectDesc")}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!short) reject.mutate();
        }}
      >
        <Input label={t("ui.reason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} error={touched && short ? t("ui.reasonShort") : undefined} />
        <InlineError error={reject.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t("ui.cancel")}</Button>
          <Button type="submit" variant="danger" disabled={reject.isPending}>
            {t("pay.reject")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
