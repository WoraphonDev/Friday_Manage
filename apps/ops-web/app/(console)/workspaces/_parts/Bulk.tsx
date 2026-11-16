"use client";

import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { ApprovalsDrawer } from "@/components/dialogs";
import { Drawer, Modal, Seg } from "@/components/kit";
import { Button, InlineError, Input, Pill, Textarea, type Tone } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import styles from "./bulk.module.css";
import type { BulkAction, BulkPreview, BulkResult, BulkResultRow, BulkTarget, CouponOption } from "./types";

type T = ReturnType<typeof useTranslations<"customers.bulk">>;

/** ชื่อในหัวหน้าต่าง: 3 รายแรก + "และอีก N" */
export function namesOf(t: T, names: string[], total: number) {
  const head = names.slice(0, 3).join(", ");
  return total > 3 ? t("names", { names: head, more: total - Math.min(3, names.length) }) : head;
}

/** ตรวจก่อนทำ: POST bulk/preview (ไม่เขียนอะไร) · เปลี่ยนค่าแล้วตรวจใหม่ */
function usePreview(target: BulkTarget, params: Record<string, unknown> | null) {
  const body = params ? { ...target, ...params, reason: "ตรวจก่อนทำ" } : null;
  return useQuery({
    queryKey: ["ops", "workspaces", "bulk-preview", JSON.stringify(body)],
    queryFn: () => api.post<BulkPreview>("/workspaces/bulk/preview", body),
    enabled: !!body,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

/** สรุปผลตรวจ 3 แถว: ทำได้ทันที / ต้องอนุมัติ / ข้าม (จัดกลุ่มเหตุผล) */
function PreviewPanel({ preview, approvalText }: { preview: ReturnType<typeof usePreview>; approvalText: (p: BulkPreview) => string }) {
  const t = useTranslations("customers.bulk");
  const p = preview.data;
  const skips = new Map<string, number>();
  for (const r of p?.rows ?? []) {
    if (r.verdict !== "skip") continue;
    const key = r.code && t.has(`skipCodes.${r.code}` as "skipCodes.trial_ended") ? t(`skipCodes.${r.code}` as "skipCodes.trial_ended") : (r.reason ?? "—");
    skips.set(key, (skips.get(key) ?? 0) + 1);
  }
  return (
    <section className={styles.panel} aria-label={t("check")} aria-busy={preview.isFetching}>
      <div className={styles.panelHead}>{preview.isFetching && !p ? t("checking") : t("check")}</div>
      {preview.error ? (
        <div className={styles.panelBody}>
          <InlineError error={preview.error} />
        </div>
      ) : (
        <div className={styles.panelBody}>
          <div className={styles.sumRow}>
            <span>
              <Pill tone="ok">{t("ok")}</Pill> {t("okDesc")}
            </span>
            <b className="num" data-testid="bulk-ok">{p?.counts.ok ?? "…"}</b>
          </div>
          <div className={styles.sumRow}>
            <span>
              <Pill tone="warn">{t("approval")}</Pill> {p ? approvalText(p) : ""}
            </span>
            <b className="num" data-testid="bulk-approval">{p?.counts.approval ?? "…"}</b>
          </div>
          <div className={styles.sumRow}>
            <span>
              <Pill>{t("skip")}</Pill> {skips.size ? [...skips].map(([k, n]) => `${k} ${n}`).join(" · ") : t("skipNone")}
            </span>
            <b className="num" data-testid="bulk-skip">{p?.counts.skip ?? "…"}</b>
          </div>
        </div>
      )}
    </section>
  );
}

function Footer({ busy, disabled, label, error, onCancel, note }: { busy: boolean; disabled: boolean; label: string; error: unknown; onCancel: () => void; note?: ReactNode }) {
  const tc = useTranslations("common.dialog");
  return (
    <>
      <InlineError error={error} />
      {note && <p className="muted small">{note}</p>}
      <div className="dialog-actions">
        <Button onClick={onCancel}>{tc("cancel")}</Button>
        <Button type="submit" variant="primary" disabled={busy || disabled}>
          {busy ? tc("saving") : label}
        </Button>
      </div>
    </>
  );
}

/** H5 · ขยายทดลองใช้หลายราย */
export function BulkTrialDialog({ target, count, subtitle, onOpenChange, onDone }: { target: BulkTarget; count: number; subtitle: string; onOpenChange: (o: boolean) => void; onDone: (r: BulkResult) => void }) {
  const t = useTranslations("customers.bulk");
  const tc5 = useTranslations("customers.c5");
  const [days, setDays] = useState<"7" | "14" | "30">("7");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(false);
  const preview = usePreview(target, { action: "extend_trial", days: Number(days) });
  const p = preview.data;
  const n = p ? p.counts.ok + p.counts.approval : 0;
  const apply = useMutation({
    mutationFn: () => api.post<BulkResult>("/workspaces/bulk/apply", { ...target, action: "extend_trial", days: Number(days), reason: reason.trim(), notifyOwners: notify }),
    onSuccess: onDone,
  });
  const ok = !!p && n > 0 && reason.trim().length >= 3;
  return (
    <Modal open onOpenChange={onOpenChange} className={styles.dialog} title={t("trialTitle", { count })} description={subtitle}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && apply.mutate())}>
        <div className="field">
          <span className="field-label">{t("extend")}</span>
          <Seg label={t("extend")} value={days} onChange={setDays} options={[{ value: "7", label: tc5("d7") }, { value: "14", label: tc5("d14") }, { value: "30", label: tc5("d30") }]} />
          <span className="muted small">{t("sameDays")}</span>
        </div>
        <PreviewPanel preview={preview} approvalText={(x) => t("approvalTrial", { days: x.limits.trialDays, next: x.limits.trialTimes + 1 })} />
        <Textarea label={t("reasonCustomer")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>{t("notifyOwners")}</span>
        </label>
        <Footer busy={apply.isPending} disabled={!ok} label={t("trialSubmit", { count: n })} error={apply.error} onCancel={() => onOpenChange(false)} note={p?.counts.approval ? t("approvalNote", { count: p.counts.approval }) : undefined} />
      </form>
    </Modal>
  );
}

/** "CODE · ลด 20% 3 รอบ · เหลือ N สิทธิ์ · หมด 31 ธ.ค." */
function couponLabel(t: T, c: CouponOption, fmt: ReturnType<typeof useFormatter>) {
  const what = c.kind === "percent" ? t("pct", { value: c.value }) : c.kind === "amount" ? t("amount", { value: fmt.number(c.value / 100, { style: "currency", currency: "THB", maximumFractionDigits: 0 }) }) : t("free", { value: c.value });
  const cycles = c.kind === "free_months" ? "" : ` ${c.duration === "forever" ? t("forever") : t("cycles", { count: c.duration === "once" ? 1 : (c.durationCycles ?? 1) })}`;
  return t("couponLabel", {
    code: c.code,
    what: `${what}${cycles}`,
    left: c.maxRedemptions === null ? t("unlimited") : t("left", { count: Math.max(0, c.maxRedemptions - c.used) }),
    expiry: c.expiresOn ? t("expires", { date: fmt.dateTime(new Date(`${c.expiresOn}T00:00:00+07:00`), { day: "numeric", month: "short" }) }) : t("noExpiry"),
  });
}

/** H7 · ให้คูปองที่มีอยู่ หรือส่วนลดเฉพาะราย (หลายราย) */
export function BulkCouponDialog({ target, count, subtitle, onOpenChange, onDone }: { target: BulkTarget; count: number; subtitle: string; onOpenChange: (o: boolean) => void; onDone: (r: BulkResult, action: BulkAction) => void }) {
  const t = useTranslations("customers.bulk");
  const tc3 = useTranslations("customers.c3");
  const fmt = useFormatter();
  const me = useMe().data;
  const [mode, setMode] = useState<"coupon" | "discount">("coupon");
  const [couponId, setCouponId] = useState("");
  const [percent, setPercent] = useState("15");
  const [months, setMonths] = useState("6");
  const [forever, setForever] = useState(false);
  const [reason, setReason] = useState("");
  const coupons = useQuery({ queryKey: ["ops", "promotions"], queryFn: () => api.get<{ coupons: CouponOption[] }>("/promotions") });
  const active = (coupons.data?.coupons ?? []).filter((c) => c.state === "active");
  const pick = couponId || active[0]?.id || "";
  const discountParams = Number(percent) >= 1 && Number(percent) <= 100 && (forever || Number(months) >= 1) ? { action: "discount", percent: Number(percent), ...(forever ? {} : { months: Number(months) }) } : null;
  const params = mode === "coupon" ? (pick ? { action: "coupon", couponId: pick } : null) : discountParams;
  const preview = usePreview(target, params);
  const p = preview.data;
  const n = p ? p.counts.ok + p.counts.approval : 0;
  // วงเงินจริงของพนักงาน: ผลตรวจจากเซิร์ฟเวอร์ก่อน แล้วค่อยใช้ของ session
  const limits = p?.limits ?? me?.limits;
  const apply = useMutation({
    mutationFn: () => api.post<BulkResult>("/workspaces/bulk/apply", { ...target, ...params, reason: reason.trim() }),
    onSuccess: (r) => onDone(r, mode),
  });
  const ok = !!params && !!p && n > 0 && reason.trim().length >= 3;
  return (
    <Modal open onOpenChange={onOpenChange} className={styles.dialog} title={t("couponTitle", { count })} description={subtitle}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && apply.mutate())}>
        <fieldset className={styles.choices}>
          <legend className="sr-only">{t("couponTitle", { count })}</legend>
          <label className="check">
            <input type="radio" name="bulk-coupon-mode" checked={mode === "coupon"} onChange={() => setMode("coupon")} />
            <span>
              <b>{t("useCoupon")}</b> <span className="muted small">· {t("useCouponHint")}</span>
            </span>
          </label>
          {mode === "coupon" && (
            <div className={styles.indent}>
              <label className="field-label" htmlFor="bulk-coupon">
                {t("coupon")}
              </label>
              <select id="bulk-coupon" className="input" value={pick} onChange={(e) => setCouponId(e.target.value)} disabled={!active.length}>
                {!active.length && <option value="">{coupons.isPending ? "…" : t("noCoupons")}</option>}
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {couponLabel(t, c, fmt)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="check">
            <input type="radio" name="bulk-coupon-mode" checked={mode === "discount"} onChange={() => setMode("discount")} />
            <span>
              <b>{t("custom")}</b> <span className="muted small">· {t("customHint")}</span>
            </span>
          </label>
          {mode === "discount" && (
            <div className={styles.indent}>
              <div className="grid-2">
                <Input label={tc3("percent")} type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
                <Input label={tc3("months")} type="number" min={1} max={36} value={months} disabled={forever} onChange={(e) => setMonths(e.target.value)} />
              </div>
              <label className="check">
                <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} />
                <span>{tc3("forever")}</span>
              </label>
            </div>
          )}
        </fieldset>
        {limits && <p className={styles.info}>{t("limits", { pct: limits.discountPct, cycles: limits.discountCycles })}</p>}
        {params && <PreviewPanel preview={preview} approvalText={(x) => t("approvalDiscount", { pct: x.limits.discountPct, cycles: x.limits.discountCycles })} />}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <Footer
          busy={apply.isPending}
          disabled={!ok}
          label={mode === "coupon" ? t("couponSubmit", { count: n }) : t("discountSubmit", { count: n })}
          error={apply.error}
          onCancel={() => onOpenChange(false)}
          note={
            <>
              {t("financeNote")}
              {p?.counts.approval ? ` · ${t("approvalNote", { count: p.counts.approval })}` : ""}
            </>
          }
        />
      </form>
    </Modal>
  );
}

const TONE: Record<BulkResultRow["result"], Tone> = { done: "ok", pending: "warn", skipped: "neu", failed: "bad" };

/** CSV ผลรายแถว (มี BOM ให้ Excel อ่านภาษาไทยได้) */
function downloadCsv(t: T, r: BulkResult) {
  const esc = (v: string | null) => {
    const s = v ?? "";
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [[t("col_ws"), "slug", t("col_result"), t("col_detail"), "approval"], ...r.rows.map((x) => [x.name, x.slug, t(`r_${x.result}`), x.detail, x.approvalId])];
  const csv = "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n") + "\r\n";
  if (typeof URL.createObjectURL !== "function") return csv;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `bulk-${r.batchId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return csv;
}

/** H6 · ผลรายแถว (ใช้ร่วมทุก action) */
export function BulkResultDrawer({ action, result, onOpenChange }: { action: BulkAction; result: BulkResult; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("customers.bulk");
  const fmt = useFormatter();
  const [show, setShow] = useState<"all" | BulkResultRow["result"]>(result.counts.pending ? "pending" : "all");
  const [approvals, setApprovals] = useState(false);
  const c = result.counts;
  const total = Math.max(1, c.done + c.pending + c.skipped + c.failed);
  const seconds = Math.max(0, Math.round((Date.parse(result.finishedAt) - Date.parse(result.startedAt)) / 1000));
  const rows = show === "all" ? result.rows : result.rows.filter((r) => r.result === show);
  const pct = (n: number) => `${(n * 100) / total}%`;
  return (
    <>
      <Drawer open onOpenChange={onOpenChange} title={t(`done_${action}`)} description={t("doneSub", { time: fmt.dateTime(new Date(result.startedAt), { timeStyle: "short" }), seconds })}>
        <div className={styles.progress} aria-hidden="true">
          <span className={styles.barDone} style={{ width: pct(c.done) }} />
          <span className={styles.barPending} style={{ width: pct(c.pending) }} />
          <span className={styles.barSkipped} style={{ width: pct(c.skipped) }} />
          <span className={styles.barFailed} style={{ width: pct(c.failed) }} />
        </div>
        <div className="row">
          <Pill tone="ok">{t("countDone", { count: c.done })}</Pill>
          <Pill tone="warn">{t("countPending", { count: c.pending })}</Pill>
          <Pill>{t("countSkipped", { count: c.skipped })}</Pill>
          <Pill tone="bad">{t("countFailed", { count: c.failed })}</Pill>
        </div>
        <Seg
          label={t("filterLabel")}
          value={show}
          onChange={setShow}
          options={[
            { value: "all", label: t("filterAll") },
            { value: "pending", label: t("countPending", { count: c.pending }) },
            { value: "skipped", label: t("countSkipped", { count: c.skipped }) },
            ...(c.failed ? [{ value: "failed" as const, label: t("countFailed", { count: c.failed }) }] : []),
          ]}
        />
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("col_ws")}</th>
                <th>{t("col_result")}</th>
                <th>{t("col_detail")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.workspaceId}>
                  <td>{r.name}</td>
                  <td>
                    <Pill tone={TONE[r.result]}>{t(`r_${r.result}`)}</Pill>
                  </td>
                  <td className="small">{[r.detail, r.approvalId ? t("request", { id: r.approvalId.slice(0, 8) }) : null].filter(Boolean).join(" · ")}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    {t("empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t("batch", { id: result.batchId.slice(0, 8) })}</p>
        <div className="dialog-actions">
          <Button onClick={() => downloadCsv(t, result)}>{t("csv")}</Button>
          {c.pending > 0 && (
            <Button variant="primary" onClick={() => setApprovals(true)}>
              {t("openApprovals", { count: c.pending })}
            </Button>
          )}
        </div>
      </Drawer>
      {approvals && <ApprovalsDrawer open onOpenChange={setApprovals} />}
    </>
  );
}
