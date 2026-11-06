"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, ErrorState, InlineError, Input, LoadingState, Pill, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBaht, formatDate } from "@/lib/format";
import { keys } from "@/lib/query";
import { can } from "@/lib/roles";
import type { OpenSession, WorkspaceDetail } from "@/lib/types";
import { useStaff } from "../shell/Shell";
import { ActionDialog, type ActionKind } from "./ActionDialog";
import { useWorkspaceStatus } from "./Workspaces";

export function WorkspaceDetailPanel({ id }: { id: string }) {
  const t = useTranslations("ops");
  const staff = useStaff();
  const q = useQuery({ queryKey: keys.workspace(id), queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${id}`) });
  const statusOf = useWorkspaceStatus();
  const [action, setAction] = useState<ActionKind | null>(null);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const w = q.data;
  const sub = w.subscription;
  const st = statusOf(w, sub);
  const owners = w.owners.filter((o) => o.role === "owner");
  const role = staff?.role;
  const actions: { kind: ActionKind; label: string; danger?: boolean }[] = [];
  if (can(role, "support") && sub?.status === "trialing") actions.push({ kind: "extend", label: t("ws.extend") });
  if (can(role, "finance") && sub) actions.push({ kind: "discount", label: t("ws.discount") }, { kind: "plan", label: t("ws.changePlan") });
  if (can(role, "admin") && w.status === "suspended") actions.push({ kind: "resume", label: t("ws.resume") });
  else if (can(role, "admin") && w.status !== "pending_delete") actions.push({ kind: "suspend", label: t("ws.suspend"), danger: true });

  return (
    <>
      <div className="ch">
        <div className="min0">
          <h2>{w.name}</h2>
          <span className="muted mono">{w.slug}</span>
        </div>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      <div className="kvs">
        <div className="kv">
          <span className="muted">{t("ws.kvPlan")}</span>
          <span>{sub ? `${sub.plan ? t(`plans.${sub.plan}`) : t("plans.none")} · ${t(`cycles.${sub.cycle}`)}` : t("plans.none")}</span>
        </div>
        <div className="kv">
          <span className="muted">{t("ws.kvMembers")}</span>
          <span>{t("ws.membersValue", { members: w.usage.members, guests: w.usage.guests })}</span>
        </div>
        <div className="kv">
          <span className="muted">{t("ws.kvUsage")}</span>
          <span>{t("ws.usageValue", { projects: w.usage.projects, issues: w.usage.issues })}</span>
        </div>
        <div className="kv">
          <span className="muted">{t("ws.kvPay")}</span>
          <span>{sub?.paymentMethod ? t(`methods.${sub.paymentMethod as "card"}`) : t("ui.none")}</span>
        </div>
        {sub?.discount && (
          <div className="kv">
            <span className="muted">{t("ws.kvDiscount")}</span>
            <span>{t("ws.discountValue", { percent: sub.discount.percent, months: sub.discount.months ? t("ws.discountMonths", { months: sub.discount.months }) : t("ws.discountForever") })}</span>
          </div>
        )}
        {sub?.status === "trialing" && (
          <div className="kv">
            <span className="muted">{t("ws.kvTrial")}</span>
            <span>{formatDate(sub.trialEndsAt)}</span>
          </div>
        )}
        <div className="kv">
          <span className="muted">{t("ws.kvOwner")}</span>
          <span className="ellipsis">{owners.map((o) => o.email).join(", ") || t("ui.none")}</span>
        </div>
        <div className="kv">
          <span className="muted">{t("ws.kvCreated")}</span>
          <span>{formatDate(w.createdAt)}</span>
        </div>
      </div>
      <div className="detail-body">
        {can(role, "support") && <SupportAccess w={w} />}
        {actions.length > 0 && (
          <div className="actions">
            {actions.map((a) => (
              <Button key={a.kind} className={a.danger ? "danger-text" : undefined} onClick={() => setAction(a.kind)}>
                {a.label}
              </Button>
            ))}
          </div>
        )}
        {w.invoices.length > 0 && (
          <div className="invoices">
            <b className="small-13">{t("ws.invoices")}</b>
            {w.invoices.slice(0, 5).map((i) => (
              <div className="kv" key={i.id}>
                <span className="mono">{i.number}</span>
                <span>
                  {formatBaht(i.total)} · {i.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {action && <ActionDialog kind={action} workspace={w} onClose={() => setAction(null)} />}
    </>
  );
}

/** ฟอร์มเริ่ม support session (Canvas: เข้าบัญชีเพื่อช่วยเหลือ) · ต้องมี grant ของลูกค้าที่ยังไม่หมดอายุ */
function SupportAccess({ w }: { w: WorkspaceDetail }) {
  const t = useTranslations("ops");
  const toast = useToast();
  const cache = useQueryClient();
  const [ticket, setTicket] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"read" | "write">("read");
  const [approver, setApprover] = useState("");
  const [touched, setTouched] = useState(false);
  const start = useMutation({
    mutationFn: () => api.post<{ session: OpenSession; notified: number }>(`/workspaces/${w.id}/support-sessions`, { ticketNo: ticket.trim(), reason: reason.trim(), mode, ...(mode === "write" ? { secondApproverId: approver.trim() } : {}) }),
    onSuccess: (r) => {
      toast(t("ws.started", { count: r.notified }));
      setTicket("");
      setReason("");
      void cache.invalidateQueries({ queryKey: keys.sessions });
      void cache.invalidateQueries({ queryKey: keys.workspace(w.id) });
    },
  });
  const grant = w.supportAccess;
  if (!grant?.active)
    return (
      <div className="stack-10">
        <b className="small-13">{t("ws.support")}</b>
        <Pill tone="neu" className="self-start">
          {t("ws.notGranted")}
        </Pill>
        <span className="muted small-13">{t("ws.notGrantedHelp")}</span>
      </div>
    );
  const reasonShort = reason.trim().length < 10;
  return (
    <form
      className="stack-10"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (reasonShort) return;
        start.mutate();
      }}
    >
      <b className="small-13">{t("ws.support")}</b>
      <Pill tone="ok" className="self-start">
        {t("ws.granted", { mode: t(`modes.${grant.maxMode}`), until: grant.until ? t("ws.grantUntil", { date: formatDate(grant.until) }) : t("ws.grantForever") })}
      </Pill>
      <Input label={t("ws.ticket")} className="mono" placeholder="#0000" value={ticket} maxLength={40} onChange={(e) => setTicket(e.target.value)} />
      <Input label={t("ws.sessionReason")} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} hint={t("ws.sessionReasonHint")} error={touched && reasonShort ? t("ws.sessionReasonShort") : undefined} />
      <Select label={t("ws.mode")} value={mode} onChange={(e) => setMode(e.target.value as "read" | "write")}>
        <option value="read">{t("ws.modeRead")}</option>
        <option value="write" disabled={grant.maxMode !== "write"}>
          {t("ws.modeWrite")}
        </option>
      </Select>
      {mode === "write" && <Input label={t("ws.approver")} className="mono" value={approver} onChange={(e) => setApprover(e.target.value)} hint={t("ws.approverHint")} />}
      <InlineError error={start.error} />
      <Button variant="primary" type="submit" disabled={ticket.trim().length < 3 || start.isPending || (mode === "write" && !approver.trim())}>
        {t("ws.start")}
      </Button>
      <span className="muted small">{t("ws.sessionNote")}</span>
    </form>
  );
}
