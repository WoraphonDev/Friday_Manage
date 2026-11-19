"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { useReauth } from "@/components/dialogs";
import { Empty, ErrorBlock, ListBar, Modal, Notice, PageHead, Pager, Seg, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { BreakGlassDialog } from "@/components/shell/BreakGlass";
import { Button, errorToast, InlineError, Input, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { OPS_ROLES, type OpsRole } from "@/lib/types";
import { type Mine, useLeft } from "@/lib/jit";
import { useFmt } from "../workspaces/_parts/format";

export const JIT_KEY = ["ops", "jit"] as const;
const DURATIONS = ["30", "60", "240", "480"] as const;
type Dur = (typeof DURATIONS)[number];
const PAGE = 50;

interface Pending {
  id: string;
  role: OpsRole;
  minutes: number;
  ticketRef: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  staffId?: string;
  staffName?: string;
  staffRoles?: OpsRole[];
}
interface Overview {
  mine: Mine;
  pending: Pending[];
  stats: { requested: number; approved: number; rejected: number; waitMin: number | null; active: number } | null;
  canApprove: boolean;
}
interface Elevation {
  id: string;
  role: OpsRole;
  kind: "break_glass" | "approved";
  reason: string;
  ticketRef: string | null;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  staffId: string;
  staffName: string;
  approvedBy: string | null;
  endedBy: string | null;
  actions: number;
}

/** ทีมภายใน › ขอสิทธิ์ชั่วคราว (O52 · storyboard เฟส 3 › Story 3) · ทุกบทบาทขอได้ · Owner อนุมัติ */
export function JitPage() {
  const t = useTranslations("jit");
  const tc = useTranslations("common");
  const fmt = useFmt();
  const left = useLeft();
  const me = useMe().data;
  const params = useSearchParams();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const owner = (me?.roles ?? []).includes("owner");
  const team = hasAny(me, "owner", "auditor");
  const requested = params?.get("request") as OpsRole | null;
  const [form, setForm] = useState(!!requested && !owner);
  const [glass, setGlass] = useState(!!requested && owner);
  const [tab, setTab] = useState<"active" | "history">(params?.get("tab") === "history" ? "history" : "active");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const [offset, setOffset] = useState(0);
  const [rejecting, setRejecting] = useState<Pending | null>(null);
  const q = useQuery({ queryKey: [...JIT_KEY, "overview"], queryFn: () => api.get<Overview>("/jit"), enabled: !!me, refetchInterval: 30_000 });
  const qs = new URLSearchParams({ tab, limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}) });
  const list = useQuery({ queryKey: [...JIT_KEY, "list", qs.toString()], queryFn: () => api.get<{ items: Elevation[]; total: number }>(`/jit/elevations?${qs}`), enabled: !!me, placeholderData: keepPreviousData });
  const approve = useMutation({
    mutationFn: (p: Pending) => run(() => api.post(`/approvals/${p.id}/approve`, {}), t("approve")),
    onSuccess: (_r, p) => (toast(t("approved", { name: p.staffName ?? "" })), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/staff/me/elevations/${id}/end`),
    onSuccess: () => (toast(t("revoked")), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });

  const d = q.data;
  const roleText = (rs: OpsRole[]) => rs.map((r) => tc(`roles.${r}`)).join(", ");
  const desc = !d
    ? "…"
    : team && d.stats
      ? t("descTeam", { active: d.stats.active, requested: d.stats.requested, approved: d.stats.approved, rejected: d.stats.rejected, wait: d.stats.waitMin == null ? t("waitNone") : t("waitMin", { n: d.stats.waitMin }) })
      : t("descMine", {
          state: d.mine.active.length ? t("activeMine", { roles: roleText(d.mine.active.map((a) => a.role)) }) : d.mine.pending.length ? t("pendingMine", { roles: roleText(d.mine.pending.map((p) => p.role)) }) : t("noneActive"),
        });
  return (
    <>
      <PageHead
        title={t("title")}
        desc={desc}
        actions={
          <Button variant="primary" onClick={() => (owner ? setGlass(true) : setForm(true))}>
            <Plus size={16} /> {t("request")}
          </Button>
        }
      />
      {q.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : team ? (
        <TodoCard title={t("todo")} count={q.data.pending.length} hint={t("todoHint")} clear={{ title: t("clear"), description: t("clearNote") }}>
          {q.data.pending.map((p) => (
            <article key={p.id} className="todo-row" aria-label={p.staffName}>
              <div className="todo-main">
                <b>{t("asks", { name: p.staffName ?? "", roles: roleText(p.staffRoles ?? []), role: tc(`roles.${p.role}`), duration: t(`dur.${p.minutes}` as "dur.60") })}</b>
                <span className="small">
                  {p.ticketRef && <>Ticket {p.ticketRef} · </>}“{p.reason}”
                </span>
                <span className="muted small">{fmt.ago(p.createdAt)}</span>
              </div>
              {q.data.canApprove && (
                <span className="todo-actions">
                  <Button size="small" onClick={() => setRejecting(p)}>
                    {t("reject")}
                  </Button>
                  <Button size="small" variant="primary" disabled={approve.isPending} onClick={() => approve.mutate(p)}>
                    {t("approve")}
                  </Button>
                </span>
              )}
            </article>
          ))}
        </TodoCard>
      ) : (
        !!q.data.mine.pending.length && (
          <section className="card" aria-label={t("mine")}>
            <h2 className="card-title">{t("mine")}</h2>
            {q.data.mine.pending.map((p) => (
              <div key={p.id} className="row">
                <Pill tone="warn">{tc(`roles.${p.role}`)}</Pill>
                <span>{t(`dur.${p.minutes}` as "dur.60")}</span>
                <span className="muted small">{t("waiting", { time: fmt.dateTime(p.expiresAt) })}</span>
              </div>
            ))}
          </section>
        )
      )}

      <section className="card">
        <ListBar
          tabs={
            <Tabs
              label={t("tabs.label")}
              value={tab}
              onChange={(v) => (setTab(v), setOffset(0))}
              tabs={[
                { value: "active", label: <>{t("tabs.active")} {tab === "active" && list.data && <span className="tab-count">{list.data.total}</span>}</> },
                { value: "history", label: <>{t("tabs.history")} {tab === "history" && list.data && <span className="tab-count">{fmt.num(list.data.total)}</span>}</> },
              ]}
            />
          }
        >
          {team && (
            <div style={{ width: 240, flexShrink: 1, minWidth: 160 }}>
              <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={search} onChange={(e) => (setSearch(e.target.value), setOffset(0))} />
            </div>
          )}
        </ListBar>
        {list.isPending ? (
          <TableSkeleton rows={4} cols={5} />
        ) : list.error ? (
          <ErrorBlock error={list.error} retry={() => void list.refetch()} />
        ) : !list.data.items.length ? (
          <Empty title={t(`empty.${tab}`)} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.staff")}</th>
                    <th scope="col">{t("col.role")}</th>
                    <th scope="col">{t("col.start")}</th>
                    <th scope="col">{t("col.end")}</th>
                    <th scope="col">{t("col.by")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("col.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((e) => {
                    const active = !e.endedAt && Date.parse(e.endsAt) > Date.now();
                    return (
                      <tr key={e.id}>
                        <td>
                          <span className="cell-strong">{e.staffName}</span>
                          <div className="cell-sub clamp-1">
                            {e.ticketRef && <>Ticket {e.ticketRef} · </>}
                            {e.reason}
                          </div>
                        </td>
                        <td>
                          <Pill tone={e.kind === "break_glass" ? "bad" : "inf"}>{tc(`roles.${e.role}`)}</Pill>
                        </td>
                        <td className="small nowrap">{fmt.dateTime(e.startedAt)}</td>
                        <td className="small nowrap">
                          {active ? t("left", { d: left(e.endsAt) }) : fmt.dateTime(e.endedAt ?? e.endsAt)}
                          {e.endedBy && <div className="cell-sub">{t("endedBy", { name: e.endedBy })}</div>}
                        </td>
                        <td className="small">
                          {e.kind === "break_glass" ? t("breakGlass") : (e.approvedBy ?? "—")}
                          {team && e.actions > 0 && (
                            <div className="cell-sub">
                              <Link className="link-button" href={`/staff?tab=audit`}>
                                {t("auditLink", { n: e.actions })}
                              </Link>
                            </div>
                          )}
                        </td>
                        <td className="num">
                          {active && (owner || e.staffId === me?.id) && (
                            <Button size="small" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(e.id)}>
                              {t("revoke")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={list.data.items.length} total={list.data.total} onChange={setOffset} />
          </>
        )}
      </section>

      {form && me && <RequestDialog mine={rolesOf(me)} initial={requested ?? undefined} onClose={() => setForm(false)} />}
      {me && <BreakGlassDialog staff={me} open={glass} onOpenChange={setGlass} initialRole={requested ?? undefined} />}
      {rejecting && <RejectDialog p={rejecting} onClose={() => setRejecting(null)} />}
    </>
  );
}

/** ขั้น 1: เลือกบทบาท (ไม่รวม Owner) · ระยะเวลาสูงสุด 8 ชม. · เหตุผล · ผูก Ticket ได้ */
function RequestDialog({ mine, initial, onClose }: { mine: OpsRole[]; initial?: OpsRole; onClose: () => void }) {
  const t = useTranslations("jit.form");
  const tj = useTranslations("jit");
  const tc = useTranslations("common");
  const toast = useToast();
  const cache = useQueryClient();
  const missing = OPS_ROLES.filter((r) => r !== "owner" && !mine.includes(r));
  const [role, setRole] = useState<OpsRole | undefined>(initial && missing.includes(initial) ? initial : missing[0]);
  const [dur, setDur] = useState<Dur>("60");
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const m = useMutation({
    mutationFn: () => api.post("/jit/requests", { role, minutes: Number(dur), reason: reason.trim(), ...(ticket.trim() ? { ticketRef: ticket.trim() } : {}) }),
    onSuccess: () => (toast(t("sent")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  const ok = !!role && reason.trim().length >= 10 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      {!missing.length ? (
        <p className="muted">{t("noRoles")}</p>
      ) : (
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
          <div className="field">
            <span className="field-label">{t("role")}</span>
            <Seg label={t("role")} value={role ?? missing[0]} onChange={setRole} options={missing.map((r) => ({ value: r, label: tc(`roles.${r}`) }))} />
          </div>
          <div className="field">
            <span className="field-label">{t("duration")}</span>
            <Seg label={t("duration")} value={dur} onChange={setDur} options={DURATIONS.map((x) => ({ value: x, label: tj(`dur.${x}`) }))} />
          </div>
          <Textarea label={t("reason")} hint={t("reasonHint")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Input label={t("ticket")} placeholder={t("ticketHint")} value={ticket} onChange={(e) => setTicket(e.target.value)} />
          <Notice tone="info">{t("note")}</Notice>
          <InlineError error={m.error} />
          <div className="dialog-actions">
            <Button onClick={onClose}>{tc("dialog.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!ok}>
              {t("submit")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RejectDialog({ p, onClose }: { p: Pending; onClose: () => void }) {
  const t = useTranslations("jit");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/approvals/${p.id}/reject`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: () => (toast(t("rejected")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("rejectTitle", { name: p.staffName ?? "" })}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), !m.isPending && m.mutate())}>
        <Textarea label={t("rejectNote")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={m.isPending}>
            {t("reject")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
