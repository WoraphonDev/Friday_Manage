"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Modal, Notice, Switch, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, errorToast, InlineError, Input, Select, useToast } from "@/components/ui";
import { api, OPS_BASE } from "@/lib/api";
import { useMe } from "@/lib/query";
import styles from "./tax.module.css";
import { useTaxFmt } from "./Tax";

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const lastMonth = () => {
  const d = new Date(`${todayBkk().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

export type ExportType = "sales_tax" | "wht" | "zip";
const TYPES: ExportType[] = ["sales_tax", "wht", "zip"];
/** ลิงก์ดาวน์โหลดของแต่ละไฟล์ */
const exportFiles = (type: ExportType, month: string) =>
  type === "sales_tax"
    ? [{ key: "pdf", href: `${OPS_BASE}/revenue/sales-report?month=${month}&format=pdf` }, { key: "xlsx", href: `${OPS_BASE}/revenue/sales-report?month=${month}&format=xlsx` }]
    : type === "wht"
      ? [{ key: "csv", href: `${OPS_BASE}/revenue/export?month=${month}&type=wht` }]
      : [{ key: "zip", href: `${OPS_BASE}/revenue/export/zip?month=${month}` }];

export interface AccountingSettings {
  recipients: string[];
  auto: boolean;
  day: number;
  time: string;
  whenOpen: "wait" | "draft";
  files: { salesTax: boolean; wht: boolean; zip: boolean };
  source?: "env" | "saved";
}
export interface Delivery {
  settings: AccountingSettings;
  recipients: string[];
  autoDay: number;
  next: { date: string; time: string; month: string } | null;
  closedMonths?: string[];
  history: { at: string; month: string; detail: string; staffName: string | null; auto?: boolean; result?: "sent" | "failed" | "skipped"; draft?: boolean; files?: string[]; error?: string | null }[];
}
export const deliveryKey = ["ops", "revenue", "delivery"] as const;
export const useDelivery = () => useQuery({ queryKey: deliveryKey, queryFn: () => api.get<Delivery>("/revenue/export/delivery") });

/** E5 (B8) · ส่งออกให้สำนักงานบัญชี: เลือกงวดและไฟล์ · ประวัติทุกครั้ง · ส่งซ้ำ · ดาวน์โหลดทั้งหมด (ZIP) */
export function AccountantExport({ onClose }: { onClose: () => void }) {
  const t = useTranslations("money.b8");
  const tc = useTranslations("common.dialog");
  const me = useMe().data;
  const toast = useToast();
  const fmt = useTaxFmt();
  const cache = useQueryClient();
  const [month, setMonth] = useState(lastMonth());
  const delivery = useDelivery();
  const set = delivery.data?.settings;
  const [types, setTypes] = useState<ExportType[] | null>(null);
  const chosen = types ?? (set ? TYPES.filter((x) => (x === "sales_tax" ? set.files.salesTax : x === "wht" ? set.files.wht : set.files.zip)) : ["sales_tax", "wht"]);
  const [settings, setSettings] = useState(false);
  const closed = delivery.data?.closedMonths?.includes(month);
  const canSend = !!me && hasAny(me, "owner", "finance");
  const to = delivery.data?.recipients ?? [];
  const send = useMutation({
    mutationFn: (body: { month: string; types: ExportType[] }) => api.post<{ sent: number; to: string[]; month: string }>("/revenue/export/send", body),
    onSuccess: (r, body) => (toast(body.month === month && body.types === chosen ? t("sent", { to: r.to.join(", ") }) : t("resent", { month: fmt.month(r.month) })), void cache.invalidateQueries({ queryKey: deliveryKey })),
    onError: (e) => (void cache.invalidateQueries({ queryKey: deliveryKey }), toast(errorToast(e))),
  });
  const desc = set ? (set.auto ? t("descSettings", { day: set.day, time: set.time }) : t("descOff")) : t("desc");
  const typesOf = (files: string[] = []): ExportType[] => [...(files.includes("PDF") || files.includes("Excel") ? ["sales_tax" as const] : []), ...(files.includes("CSV") ? ["wht" as const] : []), ...(files.includes("ZIP") ? ["zip" as const] : [])];
  return (
    <>
      <Modal open={!settings} onOpenChange={(o) => !o && onClose()} title={t("title")} description={desc} className="dialog-wide">
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), chosen.length && to.length && send.mutate({ month, types: chosen }))}>
          <div className={styles.grid2}>
            <div className="stack" style={{ gap: 4 }}>
              <Input label={t("month")} type="month" value={month} onChange={(e) => setMonth(e.target.value || lastMonth())} />
              <span className={closed ? "pill ok" : "pill warn"} style={{ alignSelf: "flex-start" }}>
                {closed ? t("closedLabel") : t("draft")}
              </span>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <span className="field-label">{t("toLabel")}</span>
              {delivery.isPending ? null : to.length ? (
                <div className={styles.pills}>
                  {to.map((x) => (
                    <span key={x} className={styles.tag} style={{ paddingRight: 10 }}>
                      {x}
                    </span>
                  ))}
                </div>
              ) : (
                <Notice tone="warn" title={t("noRecipient")} />
              )}
              {canSend && (
                <button type="button" className="link-button small" style={{ alignSelf: "flex-start" }} onClick={() => setSettings(true)}>
                  {t("settingsLink")}
                </button>
              )}
            </div>
          </div>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("attach")}</legend>
            {TYPES.map((v) => (
              <div key={v} className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }}>
                <label className="check">
                  <input type="checkbox" checked={chosen.includes(v)} onChange={() => setTypes(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v])} />
                  <span>{t(`types.${v}`)}</span>
                </label>
                <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                  {exportFiles(v, month).map((f) => (
                    <a key={f.key} className="link-button small" href={f.href} download aria-label={t("downloadOne", { file: t(`files.${v}_${f.key}` as "files.wht_csv") })}>
                      {t(`format.${f.key}` as "format.csv")}
                    </a>
                  ))}
                </span>
              </div>
            ))}
          </fieldset>
          <p className="muted small">{t("notYet")}</p>
          <h3 className={styles.heading}>{t("historyTitle")}</h3>
          {delivery.isPending ? (
            <TableSkeleton rows={3} cols={5} />
          ) : !delivery.data?.history.length ? (
            <p className="muted small">{t("historyEmpty")}</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl" aria-label={t("historyTitle")}>
                <thead>
                  <tr>
                    <th>{t("col.month")}</th>
                    <th>{t("col.at")}</th>
                    <th>{t("col.by")}</th>
                    <th>{t("col.files")}</th>
                    <th>{t("col.result")}</th>
                    {canSend && <th />}
                  </tr>
                </thead>
                <tbody>
                  {delivery.data.history.map((h, i) => {
                    const result = h.result ?? "sent";
                    return (
                      <tr key={`${h.at}-${i}`}>
                        <td>{fmt.month(h.month)}</td>
                        <td className="small">{fmt.dateTime(h.at)}</td>
                        <td className="small">{h.staffName ?? t("auto")}</td>
                        <td className="small">{h.files?.length ? h.files.join(" · ") : "—"}</td>
                        <td>
                          <span className={result === "sent" ? "pill ok" : result === "failed" ? "pill bad" : "pill warn"}>{result === "sent" && h.draft ? t("result.draft") : t(`result.${result}`)}</span>
                          {h.error && <div className="cell-sub">{h.error}</div>}
                        </td>
                        {canSend && (
                          <td>
                            {result !== "skipped" && to.length > 0 && (
                              <Button size="small" disabled={send.isPending} onClick={() => send.mutate({ month: h.month, types: typesOf(h.files).length ? typesOf(h.files) : chosen })}>
                                {t("resend")}
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">{delivery.data?.next ? t("next", { date: fmt.dateYear(delivery.data.next.date), time: delivery.data.next.time, month: fmt.month(delivery.data.next.month) }) : delivery.data ? t("nextOff") : null}</p>
          <InlineError error={send.error ?? delivery.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{tc("cancel")}</Button>
            <a className={buttonClass("secondary")} href={`${OPS_BASE}/revenue/export/zip?month=${month}&scope=all`} download>
              <Download size={14} aria-hidden="true" /> {t("downloadAll")}
            </a>
            {canSend && (
              <Button type="submit" variant="primary" disabled={!chosen.length || !to.length || send.isPending}>
                <Send size={14} aria-hidden="true" /> {send.isPending ? tc("saving") : t("send")}
              </Button>
            )}
          </div>
        </form>
      </Modal>
      {settings && set && <AccountingSettingsDialog initial={set} onClose={() => setSettings(false)} />}
    </>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

/** E6 · ตั้งค่าผู้รับและวันส่ง (แทน OPS_ACCOUNTING_EMAIL / OPS_ACCOUNTING_SEND_DAY) · Owner และการเงิน */
export function AccountingSettingsDialog({ initial, onClose }: { initial: AccountingSettings; onClose: () => void }) {
  const t = useTranslations("money.e6");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [v, setV] = useState<AccountingSettings>({ recipients: initial.recipients, auto: initial.auto, day: initial.day, time: initial.time, whenOpen: initial.whenOpen, files: initial.files });
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const add = () => {
    const e = draft.trim().toLowerCase().replace(/,$/, "");
    if (!e) return;
    if (!EMAIL.test(e)) return setBad(true);
    if (!v.recipients.includes(e) && v.recipients.length < 5) setV({ ...v, recipients: [...v.recipients, e] });
    setDraft("");
    setBad(false);
  };
  const save = useMutation({
    mutationFn: () => api.put("/accounting/settings", v),
    onSuccess: () => (toast(t("saved")), void cache.invalidateQueries({ queryKey: deliveryKey }), void cache.invalidateQueries({ queryKey: ["ops", "accounting"] }), onClose()),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ to: string[] }>("/accounting/settings/test", { types: [...(v.files.salesTax ? ["sales_tax"] : []), ...(v.files.wht ? ["wht"] : []), ...(v.files.zip ? ["zip"] : [])] }),
    onSuccess: (r) => toast(t("tested", { to: r.to.join(", ") })),
    onError: (e) => toast(errorToast(e)),
  });
  const valid = (!v.auto || v.recipients.length > 0) && (v.files.salesTax || v.files.wht || v.files.zip);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), valid && save.mutate())}>
        {initial.source === "env" && <Notice>{t("fromEnv")}</Notice>}
        <div className="stack" style={{ gap: 4 }}>
          <label className="field-label" htmlFor="acc-recipient">
            {t("recipients")}
          </label>
          <div className={styles.tags}>
            {v.recipients.map((r) => (
              <span key={r} className={styles.tag}>
                {r}
                <Button size="icon" variant="ghost" aria-label={t("remove", { email: r })} onClick={() => setV({ ...v, recipients: v.recipients.filter((x) => x !== r) })}>
                  <X size={12} />
                </Button>
              </span>
            ))}
            {v.recipients.length < 5 && (
              <input
                id="acc-recipient"
                className={styles.tagInput}
                type="email"
                placeholder={t("recipientsPlaceholder")}
                value={draft}
                onChange={(e) => (setDraft(e.target.value), setBad(false))}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    add();
                  } else if (e.key === "Backspace" && !draft && v.recipients.length) setV({ ...v, recipients: v.recipients.slice(0, -1) });
                }}
              />
            )}
          </div>
          <span className={bad ? "field-error" : "muted small"}>{bad ? t("invalidEmail") : t("recipientsHint")}</span>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <Switch checked={v.auto} onChange={(auto) => setV({ ...v, auto })} label={t("auto")} />
          <b className="small">{t("auto")}</b>
        </div>
        <div className={styles.grid2}>
          <Select label={t("day")} hint={t("dayHint")} value={String(v.day)} disabled={!v.auto} onChange={(e) => setV({ ...v, day: Number(e.target.value) })}>
            {Array.from({ length: 15 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {t("dayOption", { n })}
              </option>
            ))}
          </Select>
          <Select label={t("time")} value={v.time} disabled={!v.auto} onChange={(e) => setV({ ...v, time: e.target.value })}>
            {(HOURS.includes(v.time) ? HOURS : [v.time, ...HOURS]).map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </Select>
        </div>
        <fieldset className={styles.radios} disabled={!v.auto}>
          <legend className="field-label">{t("whenOpen")}</legend>
          {(["wait", "draft"] as const).map((w) => (
            <label key={w} className={styles.radio}>
              <input type="radio" name="when-open" checked={v.whenOpen === w} onChange={() => setV({ ...v, whenOpen: w })} />
              <span>
                <b className="small">{t(w)}</b>
                <span className="muted small">{t(`${w}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <legend className="field-label">{t("files")}</legend>
          {(["salesTax", "wht", "zip"] as const).map((f) => (
            <label key={f} className="check">
              <input type="checkbox" checked={v.files[f]} onChange={() => setV({ ...v, files: { ...v.files, [f]: !v.files[f] } })} />
              <span>{t(`file.${f}`)}</span>
            </label>
          ))}
        </fieldset>
        <p className="muted small">{t("note")}</p>
        <InlineError error={save.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button disabled={test.isPending} onClick={() => test.mutate()}>
            {t("test")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
            {save.isPending ? tc("saving") : t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
