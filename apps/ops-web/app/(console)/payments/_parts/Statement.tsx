"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Modal, Notice, Pager, TableSkeleton, TodoCard, TodoRow } from "@/components/kit";
import { Button, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "./tax.module.css";

/**
 * นำเข้า statement ธนาคาร (O03 เฟส 2 · storyboard ที่ผู้ใช้เลือก 23 พ.ย. 2569)
 * ขั้น 1 ปุ่มในแท็บประวัติเงินเข้า · ขั้น 2 วางไฟล์ · ขั้น 3 ดูผลจับคู่ก่อนบันทึก · ขั้น 4 บันทึก
 * ที่จับคู่ไม่ได้ไปอยู่การ์ด "เงินเข้าจาก statement ที่ยังจับคู่ไม่ได้" ในแท็บต้องตรวจ
 */

type Kind = "slip" | "invoice" | "reconcile" | "review" | "ignored" | "duplicate";
interface Account {
  bank: string;
  accountNo: string;
  accountName: string;
}
interface Preview {
  account: Account;
  periodFrom: string | null;
  periodTo: string | null;
  deposits: number;
  withdrawals: number;
  skipped: number;
  duplicates: number;
  matched: number;
  reconciled: number;
  review: number;
  ignored: number;
  lines: { txnAt: string; amount: number; description: string; kind: Kind; reason: string | null; invoice: { number: string } | null }[];
}
export interface ReviewLine {
  id: string;
  txnAt: string;
  amount: number;
  description: string | null;
  reason: string | null;
  candidates: { id: string; number: string; amountDue: number; dueDate: string; workspace: { name: string } }[];
}

const PILL: Record<Kind, string> = { slip: "pill ok", invoice: "pill ok", reconcile: "pill inf", review: "pill warn", ignored: "pill", duplicate: "pill" };
export const statementReviewKey = ["ops", "bank-statement-lines", "review"] as const;
/** หน้าแรกของคิวใช้ cache เดียวกันทั้งการ์ดและตัวนับของแท็บต้องตรวจ */
export const fetchReview = (offset: number) => api.get<{ items: ReviewLine[]; total: number }>(`/bank-statement-lines?limit=20&offset=${offset}`);

export function StatementImportButton() {
  const t = useTranslations("money.statement");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        <FileUp size={14} aria-hidden="true" /> {t("open")}
      </Button>
      {open && <StatementImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function StatementImportDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.statement");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const recent = useQuery({ queryKey: ["ops", "bank-statements"], queryFn: () => api.get<{ account: Account }>("/bank-statements") });
  const preview = useMutation({ mutationFn: (f: File) => api.upload<Preview>("/bank-statements/preview", f, f.name) });
  const save = useMutation({
    mutationFn: () => api.upload<Preview & { id: string }>("/bank-statements", file!, file!.name),
    onSuccess: (r) => {
      toast(t("done", { matched: r.matched + r.reconciled, review: r.review }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    save.reset();
    preview.mutate(f);
  };
  const r = preview.data;
  const account = r?.account ?? recent.data?.account;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={account ? t("account", { bank: account.bank, accountNo: account.accountNo, accountName: account.accountName }) : undefined} className="dialog-wide">
      <div className="dialog-body">
        <input ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" aria-label={t("choose")} onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ""))} />
        <button
          type="button"
          className={styles.drop}
          data-dragging={dragging || undefined}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => (e.preventDefault(), setDragging(false), pick(e.dataTransfer.files?.[0]))}
        >
          <Upload size={20} aria-hidden="true" />
          {file ? <b>{file.name}</b> : <span>{t("drop")} <u>{t("choose")}</u></span>}
          {r?.periodFrom && r.periodTo ? <span>{t("period", { n: r.deposits, from: fmt.date(r.periodFrom), to: fmt.date(r.periodTo) })}</span> : <span className="small">{t("format")}</span>}
        </button>
        {!r && <Notice tone="info">{t("dedupe")}</Notice>}
        {preview.isPending && <TableSkeleton rows={3} cols={4} />}
        <InlineError error={preview.error} />
        {r && (
          <>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }} aria-label={t("summary")}>
              <span className="pill ok">{t("sum.matched", { n: r.matched + r.reconciled })}</span>
              <span className="pill warn">{t("sum.review", { n: r.review })}</span>
              <span className="pill">{t("sum.ignored", { n: r.ignored + r.withdrawals })}</span>
              {r.duplicates > 0 && <span className="pill">{t("sum.duplicates", { n: r.duplicates })}</span>}
            </div>
            {r.lines.length > 0 && (
              <div className="tbl-wrap">
                <table className="tbl" aria-label={t("result")}>
                  <thead>
                    <tr>
                      <th>{t("col.time")}</th>
                      <th className="num">{t("col.amount")}</th>
                      <th>{t("col.detail")}</th>
                      <th>{t("col.result")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="small">{fmt.dateTime(l.txnAt)}</td>
                        <td className="num">{fmt.money(l.amount)}</td>
                        <td className="small">{l.description || "—"}</td>
                        <td>
                          <span className={PILL[l.kind]}>{t(`kind.${l.kind}`)}</span>{" "}
                          {l.invoice && <span className="mono small">{l.invoice.number}</span>}
                          {l.reason && l.kind === "review" && <div className="muted small">{t(`reason.${l.reason}` as "reason.unmatched")}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button variant="primary" disabled={!r || !(r.matched + r.reconciled + r.review + r.ignored) || save.isPending} onClick={() => save.mutate()}>
            {r ? t("save", { matched: r.matched + r.reconciled, review: r.review }) : t("check")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** การ์ดในแท็บต้องตรวจ · ซ่อนเมื่อไม่มีรายการ */
export function StatementReviewCard({ canDecide }: { canDecide: boolean }) {
  const t = useTranslations("money.statement");
  const fmt = useFmt();
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: [...statementReviewKey, offset], queryFn: () => fetchReview(offset), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const [matching, setMatching] = useState<ReviewLine | null>(null);
  const [ignoring, setIgnoring] = useState<ReviewLine | null>(null);
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <>
      <TodoCard title={t("reviewTitle")} count={q.data?.total ?? items.length} hint={t("reviewHint")}>
        {items.map((l) => (
          <TodoRow
            key={l.id}
            actions={
              canDecide && (
                <>
                  <Button size="small" onClick={() => setIgnoring(l)}>
                    {t("ignore")}
                  </Button>
                  <Button size="small" variant="primary" onClick={() => setMatching(l)}>
                    {t("match")}
                  </Button>
                </>
              )
            }
          >
            <span className="pill warn">{t(`reason.${l.reason ?? "unmatched"}` as "reason.unmatched")}</span>
            <b className="num">{fmt.money(l.amount)}</b>
            <span className="small">{l.description || "—"}</span>
            <span className="muted small">{fmt.dateTime(l.txnAt)}</span>
          </TodoRow>
        ))}
        <div className="todo-row">
          <Pager offset={offset} limit={20} shown={items.length} total={q.data?.total ?? items.length} onChange={setOffset} />
        </div>
      </TodoCard>
      {matching && <LineMatchDialog line={matching} onClose={() => setMatching(null)} />}
      {ignoring && <LineIgnoreDialog line={ignoring} onClose={() => setIgnoring(null)} />}
    </>
  );
}

function LineMatchDialog({ line, onClose }: { line: ReviewLine; onClose: () => void }) {
  const t = useTranslations("money.statement");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [picked, setPicked] = useState(line.candidates.length === 1 ? line.candidates[0].id : "");
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  // ใบที่ยอดไม่ตรง (โอนขาด / เกิน) ค้นจากเลขใบแจ้งหนี้หรือชื่อ Workspace
  const found = useQuery({
    queryKey: ["ops", "invoices", "statement-match", search],
    queryFn: () => api.get<{ items: { id: string; number: string; status: string; amountDue: number; dueDate: string; workspace: { name: string } }[] }>(`/invoices?q=${encodeURIComponent(search.trim())}&limit=20`),
    enabled: search.trim().length >= 3,
  });
  const options = [...line.candidates, ...(found.data?.items ?? []).filter((i) => (i.status === "open" || i.status === "pending_review") && !line.candidates.some((c) => c.id === i.id))];
  const m = useMutation({
    mutationFn: () => api.post<{ invoice: string; creditSatang: number; remainingSatang: number }>(`/bank-statement-lines/${line.id}/match`, { invoiceId: picked, reason: reason.trim() }),
    onSuccess: (r) => {
      toast(t("matched", { invoice: r.invoice }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("matchTitle", { amount: fmt.money(line.amount) })} description={line.description || undefined}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), picked && reason.trim().length >= 3 && m.mutate())}>
        <Input label={t("search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {!options.length ? (
          <p className="muted small">{t("noCandidates")}</p>
        ) : (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">{t("pick")}</legend>
            {options.map((i) => {
              const diff = line.amount - i.amountDue;
              return (
                <label key={i.id} className="check">
                  <input type="radio" name="stmt-invoice" checked={picked === i.id} onChange={() => setPicked(i.id)} />
                  <span>
                    <b className="mono">{i.number}</b> · {i.workspace.name} · {fmt.money(i.amountDue)} ·{" "}
                    <span className={diff === 0 ? "pill ok" : diff > 0 ? "pill inf" : "pill warn"}>{diff === 0 ? t("exact") : diff > 0 ? t("over", { amount: fmt.money(diff) }) : t("under", { amount: fmt.money(-diff) })}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!picked || reason.trim().length < 3 || m.isPending}>
            {t("matchSubmit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LineIgnoreDialog({ line, onClose }: { line: ReviewLine; onClose: () => void }) {
  const t = useTranslations("money.statement");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/bank-statement-lines/${line.id}/ignore`, { reason: reason.trim() }),
    onSuccess: () => {
      toast(t("ignored"));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("ignoreTitle", { amount: fmt.money(line.amount) })} description={line.description || undefined}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        <p className="muted small">{t("ignoreNote")}</p>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < 3 || m.isPending}>
            {t("ignore")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
