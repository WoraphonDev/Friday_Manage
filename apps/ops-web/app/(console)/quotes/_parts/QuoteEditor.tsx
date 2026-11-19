"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { Drawer, Seg, Switch } from "@/components/kit";
import { Button, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "../quotes.module.css";

export const QUOTES_KEY = ["ops", "quotes"] as const;
const MONTHS = ["12", "24", "36"] as const;

export interface Quote {
  id: string;
  number: string;
  status: "draft" | "sent" | "accepted" | "declined" | "expired";
  seats: number;
  months: number;
  pricePerSeatSatang: number;
  listPerSeatSatang: number;
  subtotalSatang: number;
  vatSatang: number;
  totalSatang: number;
  discountPct: number;
  entitlements: { sso?: boolean; api_rpm?: number | null; storage_gb?: number | null };
  sla: { first: { n: number; unit: string }; resolve: { n: number; unit: string } } | null;
  contractStart: string | null;
  validUntil: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalStatus: string | null;
  sentAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  acceptedAt: string | null;
  acceptance: { name: string; title: string; po: string | null } | null;
  changeRequest: string | null;
  setup: Record<string, { status: "done" | "failed" | "waiting"; at: string; error?: string }>;
  accountId: string;
  company: string;
  leadId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  createdBy: string | null;
  createdAt: string;
  reason?: "approval" | "expiring" | "setup";
}

/** ขั้น 1 (storyboard): ซ้ายกรอก ขวาเห็นเอกสารที่ลูกค้าจะได้รับ · ใต้ยอดรวมบอกส่วนลดเทียบราคาปกติและวงเงินของคนกรอก */
export function QuoteEditor({ lead, quote, onClose, onSaved }: { lead?: { id: string; company: string }; quote?: Quote; onClose: () => void; onSaved: (id: string) => void }) {
  const t = useTranslations("quotes.editor");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const settings = useQuery({ queryKey: [...QUOTES_KEY, "settings"], queryFn: () => api.get<{ listPerSeatSatang: number; validDays: number }>("/quotes/settings") });
  const [account, setAccount] = useState<{ id: string; name: string } | null>(quote ? { id: quote.accountId, name: quote.company } : null);
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const found = useQuery({ queryKey: ["ops", "accounts", "pick", term], queryFn: () => api.get<{ items: { id: string; name: string }[] }>(`/accounts?q=${encodeURIComponent(term)}&limit=6`), enabled: !lead && !account && term.length >= 2 });
  const [seats, setSeats] = useState(String(quote?.seats ?? 50));
  const [price, setPrice] = useState(String((quote?.pricePerSeatSatang ?? 0) / 100 || ""));
  const [months, setMonths] = useState<(typeof MONTHS)[number]>(String(quote?.months ?? 12) as (typeof MONTHS)[number]);
  const [sso, setSso] = useState(quote?.entitlements.sso ?? true);
  const [apiRpm, setApiRpm] = useState(String(quote?.entitlements.api_rpm ?? 600));
  const [storage, setStorage] = useState(String(quote?.entitlements.storage_gb ?? ""));
  const [slaFirst, setSlaFirst] = useState(String(quote?.sla?.first.n ?? 1));
  const [slaResolve, setSlaResolve] = useState(String(quote?.sla?.resolve.n ?? 8));
  const [start, setStart] = useState(quote?.contractStart ?? "");
  const [until, setUntil] = useState(quote?.validUntil ?? "");
  const list = settings.data?.listPerSeatSatang ?? quote?.listPerSeatSatang ?? 40_000;
  const priceSatang = Math.round(Number(price || list / 100) * 100);
  const n = Math.max(0, Math.round(Number(seats) || 0));
  const m = Number(months);
  const subtotal = n * m * priceSatang;
  const vat = Math.round(subtotal * 0.07);
  const pct = list > 0 ? Math.max(0, Math.round((1 - priceSatang / list) * 1000) / 10) : 0;
  const limit = me?.limits?.discountPct ?? 30;
  const ents = [sso ? "SSO" : null, storage ? t("entStorage", { n: storage }) : null, apiRpm ? t("entApi", { n: apiRpm }) : null, t("entSla", { first: slaFirst, resolve: slaResolve })].filter(Boolean).join(" · ");
  const body = {
    ...(lead ? { leadId: lead.id } : { accountId: account?.id }),
    seats: n, months: m, pricePerSeatSatang: priceSatang,
    entitlements: { sso, ...(apiRpm ? { api_rpm: Number(apiRpm) } : {}), ...(storage ? { storage_gb: Number(storage) } : {}) },
    sla: { first: { n: Number(slaFirst) || 1, unit: "h" }, resolve: { n: Number(slaResolve) || 8, unit: "h" } },
    ...(start ? { contractStart: start } : {}),
    ...(until ? { validUntil: until } : {}),
  };
  const save = useMutation({
    mutationFn: () => (quote ? api.put<Quote>(`/quotes/${quote.id}`, body) : api.post<Quote>("/quotes", body)),
    onSuccess: (r) => (toast(t("saved")), void cache.invalidateQueries({ queryKey: QUOTES_KEY }), onClose(), onSaved(r.id)),
  });
  const ok = (lead || account) && n > 0 && priceSatang >= 0 && !save.isPending;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={quote ? t("editTitle", { number: quote.number }) : t("title")} wide>
      <div className={styles.editor}>
        <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && save.mutate())}>
          {lead ? (
            <p>
              <span className="muted">{t("account")} · </span>
              <b>{t("fromLead", { company: lead.company })}</b>
            </p>
          ) : account ? (
            <div className="row">
              <span className="muted">{t("account")}</span>
              <b>{account.name}</b>
              {!quote && (
                <Button size="small" variant="ghost" onClick={() => setAccount(null)}>
                  ✕
                </Button>
              )}
            </div>
          ) : (
            <div className="field">
              <Input label={t("account")} placeholder={t("pickAccount")} value={search} onChange={(e) => setSearch(e.target.value)} />
              {found.data?.items.map((a) => (
                <button key={a.id} type="button" className="menu-item" onClick={() => setAccount(a)}>
                  {a.name}
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <Input label={t("seats")} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
            <Input label={t("price")} type="number" min={0} placeholder={String(list / 100)} hint={t("listPrice", { price: fmt.money(list) })} value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">{t("months")}</span>
            <Seg label={t("months")} value={months} onChange={setMonths} options={MONTHS.map((x) => ({ value: x, label: `${x}` }))} />
          </div>
          <div className="row">
            <Switch checked={sso} onChange={setSso} label={t("sso")} />
            <span>{t("sso")}</span>
          </div>
          <div className="row">
            <Input label={t("apiRpm")} type="number" min={1} value={apiRpm} onChange={(e) => setApiRpm(e.target.value)} />
            <Input label={t("storageGb")} type="number" min={1} value={storage} onChange={(e) => setStorage(e.target.value)} />
          </div>
          <div className="row">
            <Input label={t("slaFirst")} type="number" min={1} value={slaFirst} onChange={(e) => setSlaFirst(e.target.value)} />
            <Input label={t("slaResolve")} type="number" min={1} value={slaResolve} onChange={(e) => setSlaResolve(e.target.value)} />
          </div>
          <div className="row">
            <Input label={t("start")} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input label={t("until")} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <InlineError error={save.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{tc("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!ok}>
              {t("saveDraft")}
            </Button>
          </div>
        </form>
        <section className={styles.paper} aria-label={t("preview")}>
          <p className="muted small">{quote?.number ?? "QT-…"}</p>
          <b>Friday Work Management</b>
          <span className="small">{t("to", { company: lead?.company ?? account?.name ?? "—" })}</span>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("colItem")}</th>
                <th className="num">{t("colQty")}</th>
                <th className="num">{t("colTotal")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t("item", { months: m })}</td>
                <td className="num">{t("qty", { seats: fmt.num(n), months: m })}</td>
                <td className="num">{fmt.money(subtotal)}</td>
              </tr>
              <tr>
                <td>{t("vat")}</td>
                <td />
                <td className="num">{fmt.money(vat)}</td>
              </tr>
              <tr>
                <td>
                  <b>{t("total")}</b>
                </td>
                <td />
                <td className="num">
                  <b>{fmt.money(subtotal + vat)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <p className={pct > limit ? "text-danger small" : "muted small"}>
            {t("discount", { pct, limit })}
            {pct > limit && <> · {t("over")}</>}
          </p>
          <p className="muted small">{t("includes", { list: ents })}</p>
        </section>
      </div>
    </Drawer>
  );
}
