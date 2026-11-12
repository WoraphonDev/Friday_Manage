"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Search as SearchIcon, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useDeferredValue, useState } from "react";
import { Chip, Drawer, Empty, ErrorBlock, Notice, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Pill, Select, Textarea, useToast } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import type { LookupResult, TicketView, TrashItem, TrashList, TrashType } from "./types";

interface PickedWs {
  id: string;
  name: string;
  slug: string;
}

/** แท็บ "ค้นข้อมูลที่ลบ": เลือก Workspace + Ticket (บังคับ) → รายการในถังขยะแบบสรุป · ค้นเลขงาน (Z9) · กู้คืน (Z6) */
export function Search({ canAct }: { canAct: boolean }) {
  const t = useTranslations("rst");
  const [ws, setWs] = useState<PickedWs | null>(null);
  const [ticketId, setTicketId] = useState("");
  const [submitted, setSubmitted] = useState<{ workspaceId: string; ticketId: string } | null>(null);
  const tickets = useQuery({
    queryKey: ["ops", "restore", "tickets", ws?.id],
    queryFn: () => api.get<{ items: TicketView[]; workspace: { deleted: boolean } }>(`/restore/tickets?workspaceId=${ws!.id}`),
    enabled: !!ws,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ws && ticketId) setSubmitted({ workspaceId: ws.id, ticketId });
  };
  return (
    <>
      <form className="card" onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, alignItems: "end" }}>
        <WorkspaceField value={ws} onChange={(w) => (setWs(w), setTicketId(""), setSubmitted(null))} />
        <Select label={`${t("search.ticket")} *`} value={ticketId} onChange={(e) => setTicketId(e.target.value)} disabled={!ws || !tickets.data?.items.length} hint={ws && tickets.data && !tickets.data.items.length ? t("search.ticketNone") : undefined}>
          <option value="">{t("search.ticketPick")}</option>
          {tickets.data?.items.map((x) => (
            <option key={x.id} value={x.id}>
              #{x.number} · {x.subject}
            </option>
          ))}
        </Select>
        <div className="field">
          <Button type="submit" variant="primary" disabled={!ws || !ticketId}>
            <SearchIcon size={16} /> {t("search.submit")}
          </Button>
        </div>
      </form>
      {tickets.error && <ErrorBlock error={tickets.error} retry={() => void tickets.refetch()} />}
      {tickets.data?.workspace.deleted && <Notice tone="warn" title={t("search.deletedWs")} />}
      {submitted ? <Results key={`${submitted.workspaceId}:${submitted.ticketId}`} {...submitted} canAct={canAct} /> : <Empty title={t("search.start")} description={t("search.startHint")} />}
    </>
  );
}

function WorkspaceField({ value, onChange }: { value: PickedWs | null; onChange: (w: PickedWs | null) => void }) {
  const t = useTranslations("rst.search");
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick", search],
    queryFn: () => api.get<{ items: PickedWs[] }>(`/workspaces?q=${encodeURIComponent(search)}&limit=6`),
    enabled: search.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="field">
        <span className="field-label">{t("workspace")} *</span>
        <div className="row">
          <b>{value.name}</b>
          <span className="muted small">{value.slug}</span>
          <Button size="small" variant="ghost" onClick={() => onChange(null)}>
            {t("change")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="field">
      <Input label={`${t("workspace")} *`} placeholder={t("workspacePlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      {!!found.data?.items.length && (
        <div className="row" role="listbox" aria-label={t("workspace")}>
          {found.data.items.map((w) => (
            <button key={w.id} type="button" role="option" aria-selected={false} className="chip" onClick={() => (onChange(w), setQ(""))}>
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const roleKey = (r: string | null) => (r && ["owner", "admin", "member", "guest"].includes(r) ? (r as "owner") : "unknown");

function Results({ workspaceId, ticketId, canAct }: { workspaceId: string; ticketId: string; canAct: boolean }) {
  const t = useTranslations("rst");
  const fmt = useFmt();
  const [type, setType] = useState<TrashType | "all">("all");
  const [open, setOpen] = useState<TrashItem | null>(null);
  const q = useQuery({ queryKey: ["ops", "restore", "trash", workspaceId, ticketId], queryFn: () => api.get<TrashList>(`/restore/trash?workspaceId=${workspaceId}&ticketId=${ticketId}`) });
  if (q.isPending) return <section className="card" style={{ padding: 0 }}><TableSkeleton rows={4} cols={6} /></section>;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const rows = d.items.filter((i) => type === "all" || i.type === type);
  const role = (x: TrashItem["deletedBy"]) => (x ? `${x.name} · ${t(`roles.${roleKey(x.role)}`)}` : "—");
  return (
    <>
      <Lookup workspaceId={workspaceId} />
      {!d.ticket.eligible && (
        <Notice tone="warn" icon={<TriangleAlert size={18} />} title={t("list.notEligible")}>
          {d.ticket.reason} · {t("list.requester", { email: d.ticket.requesterEmail ?? "—" })}
        </Notice>
      )}
      <section className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)", flexWrap: "wrap", gap: 8 }}>
          <h2 className="card-title">{t("list.title", { name: d.workspace.name })}</h2>
          <Chip pressed={type === "all"} onClick={() => setType("all")}>
            {t("list.all", { n: d.counts.all })}
          </Chip>
          {(["project", "issue", "file"] as const).map((k) => (
            <Chip key={k} pressed={type === k} onClick={() => setType(k)}>
              {t(`list.${k}`)}
            </Chip>
          ))}
          <span className="card-sub" style={{ marginLeft: "auto" }}>
            {t("list.privacy")}
          </span>
        </div>
        {!rows.length ? (
          <Empty ok title={t("list.empty")} description={t("list.emptyHint")} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("list.col.type")}</th>
                  <th scope="col">{t("list.col.item")}</th>
                  <th scope="col">{t("list.col.by")}</th>
                  <th scope="col">{t("list.col.at")}</th>
                  <th scope="col">{t("list.col.purge")}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.type === "issue" && i.count > 1 ? <Pill tone="inf">{t("list.batch", { n: i.count })}</Pill> : <Pill>{t(`list.${i.type}`)}</Pill>}
                    </td>
                    <td>
                      <ItemLabel item={i} />
                    </td>
                    <td className="small">{role(i.deletedBy)}</td>
                    <td className="small num">{fmt.dateTime(i.deletedAt)}</td>
                    <td>{i.daysLeft <= 3 ? <Pill tone="bad">{fmt.date(i.purgeAt)}</Pill> : <span className="small">{fmt.date(i.purgeAt)}</span>}</td>
                    <td>
                      {canAct && (
                        <Button size="small" variant={i.type === "issue" && i.count > 1 ? "primary" : "secondary"} disabled={!d.ticket.eligible} onClick={() => setOpen(i)}>
                          {i.type === "issue" && i.count > 1 ? t("list.restoreBatch") : t("list.restore")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && <RestoreDrawer list={d} item={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ItemLabel({ item: i }: { item: TrashItem }) {
  const t = useTranslations("rst.list");
  const fmt = useFmt();
  if (i.type === "project") {
    return (
      <>
        <b>
          {i.project.key} · {i.project.name}
        </b>
        <div className="muted small">
          {t("projectCounts", i.counts)}
          {i.keyTaken && ` · ${t("keyTaken")}`}
        </div>
      </>
    );
  }
  if (i.type === "file") {
    return (
      <>
        <b>{t("files", { n: i.count, size: fmt.bytes(i.sizeBytes) })}</b>
        <div className="muted small">
          {i.project.name}
          {i.folder && ` › ${i.folder}`}
        </div>
      </>
    );
  }
  if (i.count > 1) {
    return (
      <>
        <b>
          {i.project.name} ({i.project.key})
        </b>
        <div className="muted small">{t("batchSub", { range: `${i.keys[0]} … ${i.keys[i.keys.length - 1]}`, subtasks: i.subtasks })}</div>
      </>
    );
  }
  return (
    <>
      <b>{i.keys[0]}</b>
      <div className="muted small">
        {i.project.name}
        {i.subtasks > 0 && ` · ${t("subtasks", { n: i.subtasks })}`}
      </div>
    </>
  );
}

/** Z9 · ค้นด้วยเลขงาน / Key: ยังอยู่ / อยู่ในถังขยะ / ลบถาวรแล้ว (จาก Audit log) */
function Lookup({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("rst.lookup");
  const fmt = useFmt();
  const [q, setQ] = useState("");
  const m = useMutation({ mutationFn: (text: string) => api.get<LookupResult>(`/restore/lookup?workspaceId=${workspaceId}&q=${encodeURIComponent(text)}`) });
  const r = m.data;
  return (
    <section className="card">
      <form
        className="row"
        style={{ alignItems: "end", flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) m.mutate(q.trim());
        }}
      >
        <Input label={t("label")} placeholder={t("placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" disabled={q.trim().length < 2 || m.isPending}>
          {t("submit")}
        </Button>
      </form>
      <InlineError error={m.error} />
      {r && r.status === "purged" && (
        <div className="state" style={{ alignItems: "flex-start", textAlign: "left" }}>
          <span className="state-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <h2>{r.purgedAt ? t("purgedTitle", { q: r.q, date: fmt.date(r.purgedAt) }) : t("purgedTitleNoDate", { q: r.q })}</h2>
          <p className="muted">{t("purgedSub", { days: r.trashDays })}</p>
          <Notice tone="info" icon={<Info size={18} />}>
            {t("backup", { days: r.backupDays })}
          </Notice>
          <Button size="small" disabled>
            {t("backupButton")}
          </Button>
        </div>
      )}
      {r && r.status !== "purged" && <Notice tone={r.status === "not_found" ? "warn" : "info"} title={t(r.status === "live" ? "live" : r.status === "in_trash" ? "inTrash" : "notFound", { q: r.q })} />}
    </section>
  );
}

/** Z6 · กู้คืนให้ลูกค้า (Drawer ด้านขวา) · ไม่ต้องอนุมัติคนที่สอง */
function RestoreDrawer({ list, item, onClose }: { list: TrashList; item: TrashItem; onClose: () => void }) {
  const t = useTranslations("rst.z6");
  const tr = useTranslations("rst.roles");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [reply, setReply] = useState(true);
  const [newKey, setNewKey] = useState(item.type === "project" && item.keyTaken ? `${item.project.key.slice(0, 9)}2` : "");
  const by = item.deletedBy?.name ?? "—";
  const at = fmt.dateTime(item.deletedAt);
  const desc =
    item.type === "project" ? t("descProject", { key: item.project.key, project: item.project.name, by, at })
    : item.type === "file" ? t("descFile", { n: item.count, project: item.project.name, by, at })
    : item.count > 1 ? t("descBatch", { n: item.count, project: item.project.name, by, at })
    : t("descIssue", { key: item.keys[0]!, project: item.project.name, by, at });
  const needKey = item.type === "project" && (item.keyTaken || !!newKey);
  const keyOk = !needKey || /^[A-Z][A-Z0-9]{1,9}$/.test(newKey);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ restored: number; notified: number; replied: boolean }>("/restore", {
        workspaceId: list.workspace.id,
        ticketId: list.ticket.id,
        type: item.type,
        ids: item.ids,
        reason: reason.trim(),
        notify,
        replyTicket: reply,
        ...(needKey && newKey ? { newKey } : {}),
      }),
    onSuccess: (r) => {
      toast({ message: t("done", { name: list.workspace.name }), detail: t("doneDetail", { n: r.notified, replied: String(r.replied) }) });
      void cache.invalidateQueries({ queryKey: ["ops", "restore"] });
      onClose();
    },
    onError: (e) => {
      // Key ซ้ำ: ใช้ Key ที่ ops-api แนะนำ
      if (e instanceof ApiError && (e.code === "project_key_taken" || e.code === "key_taken") && typeof e.details.suggestedKey === "string") setNewKey(e.details.suggestedKey);
    },
  });
  const submitLabel = item.type === "project" ? t("submitProject") : item.type === "file" ? t("submitFile", { n: item.count }) : t("submitIssue", { n: item.count });
  const what =
    item.type === "project" ? t("whatProject", item.counts)
    : item.type === "file" ? t("whatFile", { n: item.count, size: fmt.bytes(item.sizeBytes) })
    : t("whatIssue", { n: item.count, subtasks: item.subtasks });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title", { name: list.workspace.name })} description={desc}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="muted">{t("what")}</dt>
          <dd style={{ margin: 0 }}>{what}</dd>
          <dt className="muted">{t("where")}</dt>
          <dd style={{ margin: 0 }}>{t("whereText")}</dd>
          <dt className="muted">{t("ticket")}</dt>
          <dd style={{ margin: 0 }}>
            {t("ticketFrom", { n: list.ticket.number, email: list.ticket.requesterEmail ?? "—" })}{" "}
            <Pill tone={list.ticket.eligible ? "ok" : "warn"}>{t("roleOf", { role: tr(roleKey(list.ticket.requesterRole)) })}</Pill>
          </dd>
        </dl>
        {needKey && (
          <Input
            label={`${t("newKey")} *`}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase())}
            hint={t("newKeyHint", { key: item.project.key })}
            error={!keyOk ? t("newKeyHint", { key: item.project.key }) : undefined}
            maxLength={10}
          />
        )}
        <Textarea label={`${t("reason")} *`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          {t("notify")}
        </label>
        <label className="check">
          <input type="checkbox" checked={reply} onChange={(e) => setReply(e.target.checked)} />
          {t("reply", { n: list.ticket.number })}
        </label>
        <Notice tone="info">{t("info")}</Notice>
        <InlineError error={m.error} />
        <p className="muted small">{t("note")}</p>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < 5 || !keyOk || m.isPending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
