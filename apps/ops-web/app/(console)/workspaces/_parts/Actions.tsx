"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { useReauth } from "@/components/dialogs";
import { Modal, Notice, Seg } from "@/components/kit";
import { Button, InlineError, Input, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { planLabel, useFmt } from "./format";
import type { Member, Overview } from "./types";

/** ส่วนท้ายของ Modal: ยกเลิก / ยืนยัน + error */
function Actions({ busy, disabled, label, error, onCancel, danger }: { busy: boolean; disabled?: boolean; label: string; error: unknown; onCancel: () => void; danger?: boolean }) {
  const tc = useTranslations("common.dialog");
  return (
    <>
      <InlineError error={error} />
      <div className="dialog-actions">
        <Button onClick={onCancel}>{tc("cancel")}</Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy || disabled}>
          {busy ? tc("saving") : label}
        </Button>
      </div>
    </>
  );
}
const Reason = ({ label, value, onChange, min = 3 }: { label: string; value: string; onChange: (v: string) => void; min?: number }) => {
  const tc = useTranslations("common.dialog");
  return <Textarea label={label} value={value} onChange={(e) => onChange(e.target.value)} hint={tc("reasonRequired", { min })} />;
};
const many = (names: string[]) => (names.length === 1 ? names[0] : `${names.length} Workspace`);

/** C1 · เข้าบัญชีเพื่อช่วยเหลือ (อ่านอย่างเดียว · โหมดแก้ไข "ยังไม่เปิด") */
export function EnterDialog({ ws, onOpenChange, onDone, onRequest }: { ws: Overview; onOpenChange: (o: boolean) => void; onDone: (notified: number) => void; onRequest: () => void }) {
  const t = useTranslations("customers.c1");
  const fmt = useFmt();
  const tickets = useQuery({ queryKey: ["ops", "tickets", "ws", ws.id], queryFn: () => api.get<{ items: { id: string; number: number; subject: string }[] }>(`/tickets?workspaceId=${ws.id}&status=active`) });
  const [ticketId, setTicketId] = useState("");
  const [ticketNo, setTicketNo] = useState("");
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState<"30" | "60" | "120">("60");
  const enter = useMutation({
    mutationFn: () => api.post<{ notified: number }>(`/workspaces/${ws.id}/support-sessions`, { ...(ticketId ? { ticketId } : { ticketNo: ticketNo.trim() }), reason: reason.trim(), mode: "read", durationMinutes: Number(minutes) }),
    onSuccess: (r) => onDone(r.notified),
  });
  const grant = ws.supportAccess;
  const ok = (ticketId || ticketNo.trim().length >= 3) && reason.trim().length >= 10;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: ws.name })} description={grant ? t("grant", { until: grant.until ? fmt.date(grant.until) : "—", mode: grant.maxMode === "write" ? t("modeWrite") : t("modeRead") }) : undefined}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && enter.mutate())}>
        <div className="field">
          <label htmlFor="c1-ticket">{t("ticket")}</label>
          <select id="c1-ticket" className="input" value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
            <option value="">{tickets.data?.items.length ? t("ticketPick") : t("ticketOther")}</option>
            {tickets.data?.items.map((k) => (
              <option key={k.id} value={k.id}>
                #{k.number} · {k.subject}
              </option>
            ))}
          </select>
          {!ticketId && <Input aria-label={t("ticketOther")} placeholder="#512" value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} />}
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("mode")}</legend>
          <label className="check">
            <input type="radio" checked readOnly name="c1-mode" />
            <span>
              <b>{t("read")}</b> <span className="muted">· {t("readDesc")}</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" disabled name="c1-mode" />
            <span>
              <b>{t("write")}</b> <span className="muted">· {t("writeDesc")}</span> <span className="pill">{t("notOpen")}</span>
            </span>
          </label>
        </fieldset>
        <div className="field">
          <span className="field-label">{t("duration")}</span>
          <Seg label={t("duration")} value={minutes} onChange={setMinutes} options={[{ value: "30", label: t("m30") }, { value: "60", label: t("m60") }, { value: "120", label: t("m120") }]} />
          <span className="muted small">{t("durationHint")}</span>
        </div>
        <Reason label={t("reason")} value={reason} onChange={setReason} min={10} />
        {grant?.notifyAdmins && <p className="muted small">{t("notify")}</p>}
        <p className="muted small">{t("rules")}</p>
        <Actions busy={enter.isPending} disabled={!ok} label={t("submit")} error={enter.error} onCancel={() => onOpenChange(false)} />
        {!grant?.active && (
          <Button variant="ghost" onClick={onRequest}>
            {t("requestInstead")}
          </Button>
        )}
      </form>
    </Modal>
  );
}

/** C2 · ขอสิทธิ์เข้าบัญชีจากลูกค้า */
export function RequestAccessDialog({ ws, onOpenChange, onDone }: { ws: Overview; onOpenChange: (o: boolean) => void; onDone: (sent: number) => void }) {
  const t = useTranslations("customers.c2");
  const [ticketNo, setTicketNo] = useState("");
  const [hours, setHours] = useState<"1" | "2" | "24">("1");
  const [reason, setReason] = useState("");
  const send = useMutation({ mutationFn: () => api.post<{ sent: number }>(`/workspaces/${ws.id}/support-access-request`, { ticketNo: ticketNo.trim(), hours: Number(hours), reason: reason.trim() }), onSuccess: (r) => onDone(r.sent) });
  const ok = ticketNo.trim().length >= 3 && reason.trim().length >= 10;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: ws.name })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && send.mutate())}>
        <Input label={t("ticket")} placeholder="#509" value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} />
        <div className="field">
          <span className="field-label">{t("hours")}</span>
          <Seg label={t("hours")} value={hours} onChange={setHours} options={[{ value: "1", label: t("h1") }, { value: "2", label: t("h2") }, { value: "24", label: t("h24") }]} />
        </div>
        <Reason label={t("reason")} value={reason} onChange={setReason} min={10} />
        {ok && (
          <Notice tone="info" title={t("preview")}>
            {t("previewText", { name: ws.name, hours: t(hours === "1" ? "h1" : hours === "2" ? "h2" : "h24"), reason: reason.trim(), ticket: ticketNo.trim() })}
          </Notice>
        )}
        <Actions busy={send.isPending} disabled={!ok} label={t("submit")} error={send.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}

/** C3 · ให้ส่วนลด (รายเดียวหรือหลายราย) */
export function DiscountDialog({ names, context, onOpenChange, submit }: { names: string[]; context?: ReactNode; onOpenChange: (o: boolean) => void; submit: (body: { percent: number; months?: number; reason: string }) => Promise<unknown> }) {
  const t = useTranslations("customers.c3");
  const [percent, setPercent] = useState("15");
  const [months, setMonths] = useState("6");
  const [forever, setForever] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: () => submit({ percent: Number(percent), ...(forever ? {} : { months: Number(months) }), reason: reason.trim() }), onSuccess: () => onOpenChange(false) });
  const ok = Number(percent) >= 1 && Number(percent) <= 100 && (forever || Number(months) >= 1) && reason.trim().length >= 3;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: many(names) })} description={context}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="grid-2">
          <Input label={t("percent")} type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
          <Input label={t("months")} type="number" min={1} max={36} value={months} disabled={forever} onChange={(e) => setMonths(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} />
          <span>{t("forever")}</span>
        </label>
        <p className="muted small">{t("noCombine")}</p>
        <Reason label={t("reason")} value={reason} onChange={setReason} />
        <p className="muted small">{t("limit", { pct: 30, cycles: 12 })}</p>
        <Actions busy={m.isPending} disabled={!ok} label={t("submit")} error={m.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}

/** C5 · ขยายทดลองใช้ (รายเดียวหรือหลายราย) */
export function TrialDialog({ names, trialEndsAt, context, onOpenChange, submit }: { names: string[]; trialEndsAt?: string | null; context?: ReactNode; onOpenChange: (o: boolean) => void; submit: (body: { days: number; reason: string }) => Promise<unknown> }) {
  const t = useTranslations("customers.c5");
  const fmt = useFmt();
  const [preset, setPreset] = useState<"7" | "14" | "30" | "custom">("7");
  const [custom, setCustom] = useState("10");
  const [reason, setReason] = useState("");
  const days = Number(preset === "custom" ? custom : preset);
  const m = useMutation({ mutationFn: () => submit({ days, reason: reason.trim() }), onSuccess: () => onOpenChange(false) });
  const base = trialEndsAt && Date.parse(trialEndsAt) > Date.now() ? Date.parse(trialEndsAt) : Date.now();
  const ok = days >= 1 && days <= 60 && reason.trim().length >= 3;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: many(names) })} description={context}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="field">
          <span className="field-label">{t("extend")}</span>
          <Seg label={t("extend")} value={preset} onChange={setPreset} options={[{ value: "7", label: t("d7") }, { value: "14", label: t("d14") }, { value: "30", label: t("d30") }, { value: "custom", label: t("custom") }]} />
        </div>
        {preset === "custom" && <Input label={t("days")} type="number" min={1} max={60} value={custom} onChange={(e) => setCustom(e.target.value)} />}
        {names.length === 1 && <p className="small">{t("newEnd", { date: fmt.date(new Date(base + days * 86_400_000).toISOString()) })}</p>}
        <Reason label={t("reason")} value={reason} onChange={setReason} />
        <p className="muted small">{t("limit")}</p>
        <Actions busy={m.isPending} disabled={!ok} label={t("submit")} error={m.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}

interface Preview {
  current: { plan: string; cycle: string; priceSatang: number | null; seatLimit: number | null };
  next: { plan: string; cycle: string; priceSatang: number | null; seatLimit: number | null };
  seatsInUse: number;
  blocked: { code: string; message: string } | null;
  contract: boolean;
  effective: "now" | "next_cycle";
  lines: { label: string; satang: number }[];
  subtotalSatang: number;
  vatSatang: number;
  totalSatang: number;
}

/** C4 · เปลี่ยนแพ็กเกจพร้อมตัวอย่างยอด */
/** ผลของ C4: มีผลทันที (+ ใบแจ้งหนี้ส่วนต่าง) · ตั้งไว้รอบถัดไป · ยกเลิกที่ตั้งไว้ */
export interface PlanChangeResult {
  plan: string;
  effective: "now" | "next_cycle" | "cancelled";
  effectiveAt?: string | null;
  invoice: { id: string; number: string; amountDue: number } | null;
  warnings: { code: string; message: string }[];
}
export function PlanDialog({ ws, onOpenChange, onDone }: { ws: Overview; onOpenChange: (o: boolean) => void; onDone: (r: PlanChangeResult) => void }) {
  const t = useTranslations("customers.c4");
  const fmt = useFmt();
  const cur = ws.subscription;
  const [plan, setPlan] = useState(cur?.plan === "team_l" ? "team_m" : "team_l");
  const [cycle, setCycle] = useState<"monthly" | "yearly">((cur?.cycle as "monthly" | "yearly") ?? "monthly");
  const [reason, setReason] = useState("");
  const preview = useQuery({ queryKey: ["ops", "plan-preview", ws.id, plan, cycle], queryFn: () => api.get<Preview>(`/workspaces/${ws.id}/change-plan/preview?plan=${plan}&cycle=${cycle}`) });
  const change = useMutation({ mutationFn: () => api.post<PlanChangeResult>(`/workspaces/${ws.id}/change-plan`, { plan, cycle, reason: reason.trim() }), onSuccess: (r) => onDone(r) });
  const p = preview.data;
  const ok = !!p && !p.blocked && reason.trim().length >= 3;
  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      className="dialog-wide"
      title={t("title", { name: ws.name })}
      description={cur ? t("current", { plan: planLabel(cur.plan), seatLimit: cur.seatLimit ?? "∞", cycle: cur.cycle === "yearly" ? t("yearly") : t("monthly"), seats: ws.usage.members }) : undefined}
    >
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && change.mutate())}>
        <div className="field">
          <span className="field-label">{t("newPlan")}</span>
          <Seg label={t("newPlan")} value={plan} onChange={setPlan} options={["team_s", "team_m", "team_l", "enterprise"].map((v) => ({ value: v, label: `${planLabel(v)}${v === cur?.plan ? ` · ${t("now")}` : ""}` }))} />
        </div>
        <div className="field">
          <span className="field-label">{t("cycle")}</span>
          <Seg label={t("cycle")} value={cycle} onChange={setCycle} options={[{ value: "monthly", label: t("monthly") }, { value: "yearly", label: t("yearly") }]} />
        </div>
        {p?.blocked && <Notice tone="bad" title={t("blocked", { n: p.seatsInUse })}>{p.blocked.message}</Notice>}
        {p && !p.blocked && (
          <section className="stack">
            <div className="row">
              <span className="muted">{t("effective")}:</span> <b>{p.effective === "now" ? t("effNow") : t("effNext")}</b>
            </div>
            {p.contract ? (
              <p className="muted small">{t("contractNote")}</p>
            ) : (
              <table className="tbl" aria-label={t("preview")}>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.label}>
                      <td>{l.label}</td>
                      <td className="num">{fmt.money(l.satang)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">{t("vat")}</td>
                    <td className="num">{fmt.money(p.vatSatang)}</td>
                  </tr>
                  <tr>
                    <td className="cell-main">{t("total")}</td>
                    <td className="num cell-main">{fmt.money(p.totalSatang)}</td>
                  </tr>
                </tbody>
              </table>
            )}
            {cur?.pending && <Notice tone="warn" title={t("pendingNote", { plan: planLabel(cur.pending.plan), date: fmt.date(cur.pending.at) })} />}
            <p className="muted small">{plan === cur?.plan && cycle === cur?.cycle && cur?.pending ? t("cancelNote") : p.effective === "now" ? (p.contract ? t("contractInvoice") : p.totalSatang > 0 ? t("invoiceNote") : t("noCharge")) : t("nextNote")}</p>
          </section>
        )}
        <Reason label={t("reason")} value={reason} onChange={setReason} />
        <Actions busy={change.isPending} disabled={!ok} label={t("submit")} error={change.error ?? preview.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}

/** C6 · ระงับ: พิมพ์ slug ยืนยัน · การเงินระงับได้เองเฉพาะค้างชำระตามนโยบาย */
export interface SuspendBody {
  reason: string;
  policy?: "overdue";
  mode: "read_only" | "full";
  message: string;
  autoResume: boolean;
}
export function SuspendDialog({ ws, canPolicy, onOpenChange, submit }: { ws: Overview; canPolicy: boolean; onOpenChange: (o: boolean) => void; submit: (body: SuspendBody) => Promise<unknown> }) {
  const t = useTranslations("customers.c6");
  const tc = useTranslations("common.dialog");
  const [reason, setReason] = useState("");
  const [policy, setPolicy] = useState(canPolicy && ws.subscription?.status === "past_due");
  // ค้างชำระ = อ่านอย่างเดียว + เปิดเองเมื่อชำระ · อื่น ๆ เลือกเอง (Canvas C6)
  const [mode, setMode] = useState<SuspendBody["mode"]>("read_only");
  const [message, setMessage] = useState(() => t(policy ? "messageOverdue" : "messageDefault"));
  const [autoResume, setAutoResume] = useState(policy);
  const [typed, setTyped] = useState("");
  const m = useMutation({
    mutationFn: () => submit({ reason: reason.trim(), ...(policy ? { policy: "overdue" as const } : {}), mode: policy ? "read_only" : mode, message: message.trim(), autoResume: policy || autoResume }),
    onSuccess: () => onOpenChange(false),
  });
  const ok = reason.trim().length >= 3 && message.trim().length >= 3 && typed.trim() === ws.slug;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: ws.name })} description={t("desc", { n: ws.usage.members + ws.usage.guests })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        {canPolicy && (
          <label className="check">
            <input
              type="checkbox"
              checked={policy}
              onChange={(e) => {
                setPolicy(e.target.checked);
                if (e.target.checked) (setMode("read_only"), setAutoResume(true), setMessage(t("messageOverdue")));
              }}
            />
            <span>{t("overdue")}</span>
          </label>
        )}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("mode")}</legend>
          {(["read_only", "full"] as const).map((v) => (
            <label key={v} className="check">
              <input type="radio" name="c6-mode" value={v} checked={(policy ? "read_only" : mode) === v} disabled={policy && v === "full"} onChange={() => setMode(v)} />
              <span>
                <b>{t(`modes.${v}`)}</b> <span className="muted">· {t(`modes.${v}Desc`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Reason label={t("reason")} value={reason} onChange={setReason} />
        <Textarea label={t("message")} value={message} onChange={(e) => setMessage(e.target.value)} hint={t("messageHint")} />
        <label className="check">
          <input type="checkbox" checked={policy || autoResume} disabled={policy} onChange={(e) => setAutoResume(e.target.checked)} />
          <span>{t("autoResume")}</span>
        </label>
        <Input label={tc("typeToConfirm", { word: ws.slug })} className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        {ws.subscription?.status === "active" && !policy && <p className="muted small">{t("paidNote")}</p>}
        <Actions busy={m.isPending} disabled={!ok} danger label={t("submit")} error={m.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}

/** C7 · โอนความเป็นเจ้าของ: หลักฐานครบ · แตะกุญแจ · ส่งให้คนที่สองอนุมัติ (รอคัดค้าน 7 วัน) */
export function TransferDialog({ ws, members, onOpenChange, onDone }: { ws: Overview; members: Member[]; onOpenChange: (o: boolean) => void; onDone: (r: unknown) => void }) {
  const t = useTranslations("customers.c7");
  const { run } = useReauth();
  const owners = members.filter((m) => m.role === "owner" && m.status === "active");
  const candidates = members.filter((m) => m.status === "active" && m.role !== "owner" && m.role !== "guest" && !m.disabled);
  const [to, setTo] = useState("");
  const [letter, setLetter] = useState(false);
  const [legal, setLegal] = useState(false);
  const [ticketNo, setTicketNo] = useState("");
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => run(() => api.post(`/workspaces/${ws.id}/transfer-owner`, { newOwnerUserId: to, ticketNo: ticketNo.trim(), reason: reason.trim(), evidence: { companyLetter: letter, legalNameMatches: legal } }), t("title", { name: ws.name })),
    onSuccess: (r) => onDone(r),
  });
  const ok = !!to && letter && legal && ticketNo.trim().length >= 3 && reason.trim().length >= 10;
  return (
    <Modal open onOpenChange={onOpenChange} title={t("title", { name: ws.name })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <div className="small">
          <span className="muted">{t("oldOwner")}: </span>
          {owners.map((o) => o.email ?? o.displayName).join(", ") || "—"}
        </div>
        <div className="field">
          <label htmlFor="c7-to">{t("newOwner")}</label>
          <select id="c7-to" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t("pick")}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.email ?? c.displayName} · {c.role}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">{t("evidence")}</legend>
          <label className="check">
            <input type="checkbox" checked={letter} onChange={(e) => setLetter(e.target.checked)} />
            <span>{t("letter")}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={legal} onChange={(e) => setLegal(e.target.checked)} />
            <span>{t("legal")}</span>
          </label>
        </fieldset>
        <Input label={t("ticket")} placeholder="#503" value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} />
        <Reason label={t("reason")} value={reason} onChange={setReason} min={10} />
        <Notice tone="warn" title={t("notice")}>
          {t("objection")}
        </Notice>
        <Actions busy={m.isPending} disabled={!ok} label={t("submit")} error={m.error} onCancel={() => onOpenChange(false)} />
      </form>
    </Modal>
  );
}
