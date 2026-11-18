"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { Modal } from "@/components/kit";
import { Button, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useSupportStaff } from "@/lib/staff-options";
import { type Account, ACCOUNTS_KEY, type Contact, type Dur } from "./types";

const useRefresh = () => {
  const cache = useQueryClient();
  return () => {
    void cache.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    void cache.invalidateQueries({ queryKey: ["ops", "workspaces"] });
  };
};

/** แก้ข้อมูลบัญชี: ชื่อ เลขภาษี ผู้ดูแล ประเภท ผู้ติดต่อ บันทึกของทีม (Owner / Support) */
export function EditAccountDialog({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const t = useTranslations("customers.accounts");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const refresh = useRefresh();
  const staff = useSupportStaff();
  const [name, setName] = useState(a.name);
  const [tax, setTax] = useState(a.taxIds.join(", "));
  const [managerId, setManagerId] = useState(a.managerId ?? "");
  const [kind, setKind] = useState(a.kind);
  const [contacts, setContacts] = useState<Contact[]>(a.contacts ?? []);
  const [notes, setNotes] = useState(a.notes ?? "");
  const m = useMutation({
    mutationFn: () =>
      api.patch<Account>(`/accounts/${a.id}`, {
        name: name.trim(),
        taxIds: tax.split(/[,\s]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean),
        managerId: managerId || null,
        kind,
        contacts: contacts.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), role: c.role, ...(c.email?.trim() ? { email: c.email.trim() } : {}), ...(c.phone?.trim() ? { phone: c.phone.trim() } : {}) })),
        notes: notes.trim() || null,
      }),
    onSuccess: () => (refresh(), toast(t("edit.saved")), onClose()),
  });
  const set = (i: number, patch: Partial<Contact>) => setContacts(contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("edit.title")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), name.trim().length >= 2 && m.mutate())}>
        <Input label={t("create.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t("create.taxIds")} value={tax} inputMode="numeric" onChange={(e) => setTax(e.target.value)} />
        <div className="row">
          <Select label={t("create.manager")} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">{t("create.none")}</option>
            {staff.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
            {a.managerId && !staff.some((s) => s.value === a.managerId) && <option value={a.managerId}>{a.managerName}</option>}
          </Select>
          <Select label={t("create.kind")} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {(["standard", "enterprise"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("edit.contacts")}</legend>
          {contacts.map((c, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-end" }}>
              <Input label={t("edit.cName")} value={c.name} onChange={(e) => set(i, { name: e.target.value })} />
              <Input label={t("edit.cEmail")} type="email" value={c.email ?? ""} onChange={(e) => set(i, { email: e.target.value })} />
              <Input label={t("edit.cPhone")} value={c.phone ?? ""} onChange={(e) => set(i, { phone: e.target.value })} />
              <Select label={t("edit.cRole")} value={c.role} onChange={(e) => set(i, { role: e.target.value as Contact["role"] })}>
                {(["signer", "billing", "it", "other"] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`contactRole.${r}`)}
                  </option>
                ))}
              </Select>
              <Button type="button" size="small" variant="ghost" aria-label={t("edit.cRemove", { n: i + 1 })} onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="small" onClick={() => setContacts([...contacts, { name: "", role: "signer" }])}>
              {t("edit.addContact")}
            </Button>
          </div>
        </fieldset>
        <Textarea label={t("detail.notes")} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim().length < 2 || m.isPending}>
            {tc("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DurField({ label, value, onChange }: { label: string; value: Dur; onChange: (d: Dur) => void }) {
  const t = useTranslations("customers.accounts.contract");
  return (
    <div className="row" style={{ alignItems: "flex-end" }}>
      <Input label={label} type="number" min={1} max={999} value={String(value.n)} onChange={(e) => onChange({ ...value, n: Math.max(1, Number(e.target.value) || 1) })} />
      <Select aria-label={`${label} · หน่วย`} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Dur["unit"] })}>
        <option value="h">{t("unitH")}</option>
        <option value="d">{t("unitD")}</option>
      </Select>
    </div>
  );
}

/** สัญญา: วันเริ่ม–สิ้นสุด มูลค่า ที่นั่ง และ SLA ตามสัญญา (Owner / การเงิน) */
export function ContractDialog({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const t = useTranslations("customers.accounts.contract");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const refresh = useRefresh();
  const [start, setStart] = useState(a.contractStart ?? "");
  const [end, setEnd] = useState(a.contractEnd ?? "");
  const [value, setValue] = useState(a.contractValue != null ? String(a.contractValue / 100) : "");
  const [seats, setSeats] = useState(a.contractSeats != null ? String(a.contractSeats) : "");
  const [useSla, setUseSla] = useState(!!a.contractSla);
  const [first, setFirst] = useState<Dur>(a.contractSla?.first ?? { n: 1, unit: "h" });
  const [resolve, setResolve] = useState<Dur>(a.contractSla?.resolve ?? { n: 1, unit: "d" });
  const m = useMutation({
    mutationFn: () =>
      api.put<Account>(`/accounts/${a.id}/contract`, {
        start: start || null,
        end: end || null,
        value: value.trim() ? Math.round(Number(value) * 100) : null,
        seats: seats.trim() ? Number(seats) : null,
        sla: useSla ? { first, resolve } : null,
      }),
    onSuccess: () => (refresh(), toast(t("saved")), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <div className="row">
          <Input label={t("start")} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label={t("end")} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="row">
          <Input label={t("value")} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))} />
          <Input label={t("seats")} inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value.replace(/\D/g, ""))} />
        </div>
        <label className="check">
          <input type="checkbox" checked={useSla} onChange={(e) => setUseSla(e.target.checked)} />
          <span>{t("useSla")}</span>
        </label>
        {useSla && (
          <>
            <DurField label={t("first")} value={first} onChange={setFirst} />
            <DurField label={t("resolve")} value={resolve} onChange={setResolve} />
          </>
        )}
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {tc("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** เพิ่ม Workspace (เช่น บริษัทในเครือที่เลขภาษีต่างกัน) · ค้นที่ ops-api · ตัวที่อยู่บัญชีอื่นแล้วเลือกไม่ได้ */
export function AddWorkspacesDialog({ account: a, onClose }: { account: Account; onClose: () => void }) {
  const t = useTranslations("customers.accounts.add");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const refresh = useRefresh();
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim());
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "account-pick", term],
    queryFn: () => api.get<{ items: { id: string; name: string; slug: string; account: { id: string; name: string } | null }[] }>(`/workspaces?q=${encodeURIComponent(term)}&limit=10&sort=newest`),
    enabled: term.length >= 2,
  });
  const m = useMutation({
    mutationFn: () => api.post<Account>(`/accounts/${a.id}/workspaces`, { workspaceIds: [...picked.keys()] }),
    onSuccess: () => (refresh(), toast(t("done")), onClose()),
  });
  const toggle = (id: string, name: string, on: boolean) => {
    const next = new Map(picked);
    if (on) next.set(id, name);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), picked.size && m.mutate())}>
        <Input autoFocus aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="stack" style={{ gap: 4, margin: 0, padding: 0, listStyle: "none", maxHeight: 280, overflowY: "auto" }}>
          {(found.data?.items ?? []).map((w) => {
            const mine = w.account?.id === a.id;
            const other = !!w.account && !mine;
            return (
              <li key={w.id}>
                <label className="check">
                  <input type="checkbox" disabled={!!w.account} checked={mine || picked.has(w.id)} onChange={(e) => toggle(w.id, w.name, e.target.checked)} />
                  <span>
                    {w.name} <span className="muted small">· {w.slug}</span>
                    {other && <span className="muted small"> · {t("inAccount", { name: w.account!.name })}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!picked.size || m.isPending}>
            {t("do", { n: picked.size })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
