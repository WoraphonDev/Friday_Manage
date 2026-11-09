"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Drawer, ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { type Costs, type Marketing, RESOURCES, type Resource, rateInput, thisMonth } from "./types";

const todayBkk = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const satang = (baht: string) => Math.round(Number(baht) * 100);
const refresh = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops", "business"] });

/** B9 · ตั้งค่าต้นทุน (Drawer) · ต้นทุนต่อหน่วยมีผลตั้งแต่วันที่กำหนด · ค่าใช้จ่ายส่วนกลางกรอกรายเดือน */
export function CostSettings({ onClose }: { onClose: () => void }) {
  const t = useTranslations("ob.b9");
  const q = useQuery({ queryKey: ["ops", "business", "costs"], queryFn: () => api.get<Costs>("/costs") });
  return (
    <Drawer open wide onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      {q.isPending ? <TableSkeleton rows={7} cols={3} /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <CostForm costs={q.data} onClose={onClose} />}
    </Drawer>
  );
}

function CostForm({ costs, onClose }: { costs: Costs; onClose: () => void }) {
  const t = useTranslations("ob.b9");
  const tc = useTranslations("common.dialog");
  const f = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const byRes = new Map(costs.rates.map((r) => [r.resource, r]));
  const initial = Object.fromEntries(RESOURCES.map((r) => [r, rateInput(byRes.get(r)?.current ?? null, byRes.get(r)?.kind ?? "unit")])) as Record<Resource, string>;
  const [values, setValues] = useState(initial);
  const [from, setFrom] = useState(todayBkk());
  const [reason, setReason] = useState("");
  const [month, setMonth] = useState(costs.infra[0]?.month ?? thisMonth());
  const infraOf = (m: string) => Object.fromEntries((["aws", "tools", "other"] as const).map((c) => [c, String((costs.infra.find((x) => x.month === m && x.category === c)?.amountSatang ?? 0) / 100)])) as Record<"aws" | "tools" | "other", string>;
  const [infra, setInfra] = useState(infraOf(month));
  const changedRates = RESOURCES.filter((r) => values[r] !== initial[r] && values[r].trim() !== "" && !Number.isNaN(Number(values[r])));
  const infraBase = infraOf(month);
  const changedInfra = (["aws", "tools", "other"] as const).filter((c) => infra[c] !== infraBase[c] && !Number.isNaN(Number(infra[c])));
  const ok = (changedRates.length > 0 && reason.trim().length >= 3) || (changedInfra.length > 0 && changedRates.length === 0);
  const m = useMutation({
    mutationFn: async () => {
      if (changedRates.length)
        await api.put("/costs/rates", {
          reason: reason.trim(),
          rates: changedRates.map((r) => (byRes.get(r)?.kind === "pct" ? { resource: r, pct: Number(values[r]), effectiveFrom: from } : { resource: r, unitCostSatang: Number(values[r]) * 100, effectiveFrom: from })),
        });
      if (changedInfra.length) await api.put("/costs/infra", { month, items: changedInfra.map((c) => ({ category: c, amountSatang: satang(infra[c]) })) });
    },
    onSuccess: () => (toast(t("saved")), refresh(cache), onClose()),
  });
  const pretty = (r: Resource, raw: string | number | null) => (byRes.get(r)?.kind === "pct" ? `${Number(raw)}%` : `฿${f.number(Number(raw) / 100, { maximumFractionDigits: 4 })}`);
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("col.resource")}</th>
              <th>{t("col.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {RESOURCES.map((r) => {
              const row = byRes.get(r);
              const next = row?.scheduled[row.scheduled.length - 1];
              return (
                <tr key={r}>
                  <td>
                    {t(`resources.${r}`)}
                    {row?.current && (
                      <div className="muted small">{t("current", { value: `${pretty(r, row.kind === "pct" ? row.current.pct : row.current.unitCostSatang)} · ${f.dateTime(new Date(row.current.effectiveFrom), { dateStyle: "medium" })}` })}</div>
                    )}
                    {next && <div className="muted small">{t("scheduled", { value: pretty(r, row!.kind === "pct" ? next.pct : next.unitCostSatang), date: f.dateTime(new Date(next.effectiveFrom), { dateStyle: "medium" }) })}</div>}
                  </td>
                  <td>
                    <span className="row" style={{ flexWrap: "nowrap" }}>
                      <Input aria-label={t(`resources.${r}`)} inputMode="decimal" style={{ width: 110 }} value={values[r]} onChange={(e) => setValues({ ...values, [r]: e.target.value })} />
                      <span className="muted small">{t(`units.${r}`)}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid-2">
        <Input label={t("col.from")} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <section className="stack" style={{ gap: 8 }}>
        <h3 className="card-title">{t("infra")}</h3>
        <p className="muted small">{t("infraDesc")}</p>
        <Input
          label={t("month")}
          type="month"
          max={thisMonth()}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setInfra(infraOf(e.target.value));
          }}
        />
        <div className="grid-3">
          {(["aws", "tools", "other"] as const).map((c) => (
            <Input key={c} label={t(`categories.${c}`)} inputMode="decimal" value={infra[c]} onChange={(e) => setInfra({ ...infra, [c]: e.target.value })} />
          ))}
        </div>
      </section>
      <p className="muted small">{t("note")}</p>
      <InlineError error={m.error} />
      <div className="dialog-actions">
        <Button onClick={onClose}>{tc("cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!ok || m.isPending} title={ok ? undefined : t("nothing")}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

interface Line {
  source: string;
  amount: string;
  note: string;
  saved: boolean;
}
/** B10 · กรอกค่าการตลาดรายเดือน · แถวที่บันทึกแล้วแก้เป็น 0 ได้ (API ไม่มีลบ) */
export function MarketingCosts({ onClose }: { onClose: () => void }) {
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({ queryKey: ["ops", "business", "marketing", month], queryFn: () => api.get<Marketing>(`/marketing-costs?month=${month}`) });
  const f = useFormatter();
  const t = useTranslations("ob.b10");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { month: f.dateTime(new Date(`${month}-15T00:00:00Z`), { month: "short", year: "numeric" }) })} description={t("desc")} className="dialog-wide">
      {q.isPending ? <TableSkeleton rows={4} cols={3} /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : <MarketingForm key={month} data={q.data} month={month} setMonth={setMonth} onClose={onClose} />}
    </Modal>
  );
}

function MarketingForm({ data, month, setMonth, onClose }: { data: Marketing; month: string; setMonth: (m: string) => void; onClose: () => void }) {
  const t = useTranslations("ob.b10");
  const tb = useTranslations("ob.b9");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [lines, setLines] = useState<Line[]>(() => {
    const init = [
      ...data.items.map((i) => ({ source: i.source, amount: String(i.amountSatang / 100), note: i.note ?? "", saved: true })),
      ...data.sources.filter((s) => !data.items.some((i) => i.source === s)).map((s) => ({ source: s, amount: "", note: "", saved: false })),
    ];
    // เดือนที่ยังไม่มีอะไรเลย: เปิดแถวว่างให้กรอกทันที
    return init.length ? init : [{ source: "", amount: "", note: "", saved: false }];
  });
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const items = lines.filter((l) => l.source.trim() && l.amount.trim() !== "" && !Number.isNaN(Number(l.amount)));
  const total = items.reduce((n, l) => n + satang(l.amount), 0);
  const m = useMutation({
    mutationFn: () => api.put("/marketing-costs", { month, items: items.map((l) => ({ source: l.source.trim(), amountSatang: satang(l.amount), ...(l.note.trim() ? { note: l.note.trim() } : {}) })) }),
    onSuccess: () => (toast(t("saved")), refresh(cache), onClose()),
  });
  return (
    <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), items.length && m.mutate())}>
      <Input label={tb("month")} type="month" max={thisMonth()} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("col.source")}</th>
              <th>{t("col.amount")}</th>
              <th>{t("col.note")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.saved ? <b>{l.source}</b> : <Input aria-label={`${t("col.source")} ${i + 1}`} value={l.source} onChange={(e) => set(i, { source: e.target.value })} />}</td>
                <td>
                  <Input aria-label={`${t("col.amount")} ${l.source || i + 1}`} inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
                </td>
                <td>
                  <Input aria-label={`${t("col.note")} ${l.source || i + 1}`} value={l.note} onChange={(e) => set(i, { note: e.target.value })} />
                </td>
                <td>
                  {!l.saved && (
                    <Button size="icon" variant="ghost" aria-label={t("remove")} onClick={() => setLines(lines.filter((_, k) => k !== i))}>
                      <X size={14} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <Button size="small" onClick={() => setLines([...lines, { source: "", amount: "", note: "", saved: false }])}>
          <Plus size={14} /> {t("add")}
        </Button>
        <span className="spacer" />
        <b>{t("total", { amount: fmt.money(total) })}</b>
      </div>
      <InlineError error={m.error} />
      <div className="dialog-actions">
        <Button onClick={onClose}>{tc("cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!items.length || m.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
