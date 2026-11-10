"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny } from "@/components/access";
import { useApprovalFlow } from "@/components/dialogs";
import { Drawer, Empty, Modal, Notice, Switch } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import { type Override, type OverrideKey, type Overview, PLAN_NAME, type PlanCode, useShow, type Value } from "./types";

const DAY = 86_400_000;

/** ปรับเฉพาะราย (Override) · ตาราง + Drawer เพิ่มรายการ + ยกเลิก */
export function Overrides({ data }: { data: Overview }) {
  const t = useTranslations("ent.overrides");
  const tk = useTranslations("ent");
  const fmt = useFmt();
  const show = useShow();
  const me = useMe().data;
  const write = hasAny(me, "owner", "finance", "engineer");
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<Override | null>(null);
  const expiry = (o: Override) => {
    if (o.status === "expired") return <Pill tone="bad">{t("expired")}</Pill>;
    if (o.status === "contract") return <Pill tone="inf">{t("contract", { ref: o.contractRef ?? "" })}</Pill>;
    if (o.status === "expiring") return <Pill tone="warn">{t("daysLeft", { days: Math.max(0, Math.ceil((new Date(o.expiresAt!).getTime() - Date.now()) / DAY)) })}</Pill>;
    return (
      <Pill>
        {fmt.date(o.expiresAt)}
        {o.contractRef ? ` · ${o.contractRef}` : ""}
      </Pill>
    );
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("note")}</span>
        {write && (
          <Button variant="primary" className="push-end" onClick={() => setAdding(true)}>
            <Plus size={16} /> {t("add")}
          </Button>
        )}
      </div>
      {!data.overrides.length ? (
        <Empty title={t("empty")} description={t("emptyDesc")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.ws")}</th>
                <th scope="col">{t("col.what")}</th>
                <th scope="col" className="num">
                  {t("col.base")}
                </th>
                <th scope="col" className="num">
                  {t("col.value")}
                </th>
                <th scope="col">{t("col.expires")}</th>
                <th scope="col">{t("col.reason")}</th>
                <th scope="col">{t("col.by")}</th>
                {write && (
                  <th scope="col">
                    <span className="sr-only">{t("col.actions")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.overrides.map((o) => {
                const plan = o.workspace.plan ?? undefined;
                return (
                  <tr key={o.id}>
                    <td>
                      <div className="cell-main">{o.workspace.name}</div>
                      <div className="cell-sub">
                        {o.workspace.slug}
                        {plan ? ` · ${PLAN_NAME[plan]}` : ""}
                      </div>
                    </td>
                    <td>{tk(`overrideKeys.${o.key}` as "overrideKeys.seats")}</td>
                    <td className="num muted">{show(o.key, o.base, { plan })}</td>
                    <td className="num cell-strong">{show(o.key, o.value, { plan })}</td>
                    <td>{expiry(o)}</td>
                    <td className="small">{o.reason}</td>
                    <td className="small muted">
                      {o.createdBy}
                      {o.approvedBy && <div className="cell-sub">{t("approvedBy", { name: o.approvedBy })}</div>}
                    </td>
                    {write && (
                      <td>
                        <Button size="small" variant="ghost" onClick={() => setRevoking(o)}>
                          {t("revoke")}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <OverrideForm data={data} onClose={() => setAdding(false)} />}
      {revoking && <RevokeDialog o={revoking} onClose={() => setRevoking(null)} />}
    </section>
  );
}

function RevokeDialog({ o, onClose }: { o: Override; onClose: () => void }) {
  const t = useTranslations("ent.overrides");
  const tk = useTranslations("ent");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/entitlements/overrides/${o.id}/revoke`, { reason: reason.trim() }),
    onSuccess: () => (toast(t("revoked")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title={t("revokeTitle", { what: tk(`overrideKeys.${o.key}` as "overrideKeys.seats"), ws: o.workspace.name })} description={t("revokeDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), reason.trim().length >= 3 && m.mutate())}>
        <Textarea label={t("revokeReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={reason.trim().length < 3 || m.isPending}>
            {t("revoke")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface WsPick {
  id: string;
  name: string;
  slug: string;
  plan: PlanCode | null;
  seats: number;
}

/** เกินแพ็กเกจเกิน 20% / เปิดฟีเจอร์นอกแพ็กเกจ / ไม่มีวันหมดอายุ → Owner ต้องอนุมัติ (ops-api ตัดสินอีกครั้ง) */
function needsApproval(base: Value, value: Value, noExpiry: boolean) {
  const why: ("whyOver" | "whyFeature" | "whyNoExpiry")[] = [];
  if (typeof value === "boolean") {
    if (value && base !== true) why.push("whyFeature");
  } else if (value === null ? base !== null : typeof base === "number" && value > base * 1.2) why.push("whyOver");
  if (noExpiry) why.push("whyNoExpiry");
  return why;
}

function OverrideForm({ data, onClose }: { data: Overview; onClose: () => void }) {
  const t = useTranslations("ent.form");
  const tk = useTranslations("ent");
  const tc = useTranslations("common.dialog");
  const show = useShow();
  const toast = useToast();
  const cache = useQueryClient();
  const { handle } = useApprovalFlow();
  const [query, setQuery] = useState("");
  const [ws, setWs] = useState<WsPick | null>(null);
  const [key, setKey] = useState<OverrideKey>("seats");
  const [raw, setRaw] = useState("");
  const [on, setOn] = useState(true);
  const [expires, setExpires] = useState("");
  const [contract, setContract] = useState(false);
  const [contractRef, setContractRef] = useState("");
  const [reason, setReason] = useState("");
  const search = useDeferredValue(query.trim());
  const found = useQuery({
    queryKey: ["ops", "ent-pick", search],
    queryFn: () => api.get<{ items: WsPick[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`).then((r) => r.items),
    enabled: !ws && search.length >= 2,
  });
  const plan = ws?.plan ?? null;
  const row = plan ? data.current.matrix[plan] : null;
  const base: Value = !row ? null : key === "storage_gb" ? (row.storage_gb_per_member === null ? null : (row.storage_gb_per_member as number) * Math.max(ws!.seats, 1)) : row[key];
  const value: Value = key === "sso" ? on : raw === "" ? null : Number(raw);
  const why = ws ? needsApproval(base, value, contract) : [];
  const ok = !!ws && reason.trim().length >= 3 && (contract ? contractRef.trim().length >= 3 : !!expires) && (key === "sso" || value === null || (value as number) > 0);
  const m = useMutation({
    mutationFn: () =>
      api
        .post<{ id?: string; pendingApproval?: unknown }>("/entitlements/overrides", {
          workspaceId: ws!.id,
          key,
          value,
          expiresAt: contract ? null : `${expires}T23:59:59+07:00`,
          contractRef: contract ? contractRef.trim() : null,
          reason: reason.trim(),
        })
        .then(handle),
    onSuccess: (r) => {
      if (!r.pendingApproval) toast(t("done", { ws: ws!.name }));
      void cache.invalidateQueries({ queryKey: ["ops"] });
      onClose();
    },
    onError: (e) => toast(errorToast(e)),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {ws ? (
          <div className="field">
            <span className="field-label">{t("ws")}</span>
            <div className="row">
              <b>
                {ws.name} ({ws.slug})
              </b>
              {plan && <Pill>{PLAN_NAME[plan]}</Pill>}
              <Button size="small" variant="ghost" aria-label={tc("close")} onClick={() => setWs(null)}>
                ✕
              </Button>
            </div>
          </div>
        ) : (
          <div className="field">
            <Input label={t("ws")} placeholder={t("wsSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {found.data?.map((x) => (
              <button key={x.id} type="button" className="menu-item" onClick={() => setWs(x)}>
                {x.name} · {x.slug} {x.plan ? `· ${PLAN_NAME[x.plan]}` : ""}
              </button>
            ))}
          </div>
        )}
        <Select label={t("key")} value={key} onChange={(e) => (setKey(e.target.value as OverrideKey), setRaw(""))}>
          {data.overrideKeys.map((k) => (
            <option key={k} value={k}>
              {tk(`overrideKeys.${k}` as "overrideKeys.seats")}
            </option>
          ))}
        </Select>
        <div className="grid-2">
          <Input label={t("base")} value={ws ? show(key, base, { plan: plan ?? undefined }) : "—"} disabled readOnly />
          {key === "sso" ? (
            <div className="field">
              <span className="field-label">{t("value")}</span>
              <div className="row">
                <Switch checked={on} onChange={setOn} label={t("ssoOn")} />
                <span className="small">{on ? tk("matrix.yes") : tk("matrix.no")}</span>
              </div>
            </div>
          ) : (
            <Input label={t("value")} inputMode="numeric" className="num" hint={t("valueHint")} value={raw} onChange={(e) => setRaw(e.target.value.replace(/[^\d]/g, ""))} />
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={contract} onChange={(e) => setContract(e.target.checked)} />
          <span>{t("contract")}</span>
        </label>
        {contract ? (
          <Input label={t("contractRef")} value={contractRef} onChange={(e) => setContractRef(e.target.value)} />
        ) : (
          <Input type="date" label={t("expires")} min={new Date(Date.now() + DAY).toISOString().slice(0, 10)} value={expires} onChange={(e) => setExpires(e.target.value)} />
        )}
        <Textarea label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        {why.length > 0 ? <Notice tone="warn" title={t("needApproval", { why: why.map((w) => t(w)).join(" · ") })} /> : <Notice tone="info" title={t("rule")} />}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {why.length ? t("submitApproval") : t("submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
