"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { useReauth } from "@/components/dialogs";
import { Drawer, Empty, ErrorBlock, ListBar, Modal, NoAccess, Notice, PageHead, Pager, TableSkeleton, Tabs, TodoCard } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Pill, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useUrlFilters } from "@/lib/url-state";
import { useFmt } from "../workspaces/_parts/format";

const KEY = ["ops", "scripts"] as const;
const PAGE = 50;
interface Field {
  key: string;
  kind: "project" | "number" | "date";
  min?: number;
  max?: number;
  optional?: boolean;
}
interface Script {
  key: string;
  table: string;
  columns: string[];
  undoable: boolean;
  fields: Field[];
  lastRunAt: string | null;
  runs30: number;
}
interface Run {
  id: string;
  scriptKey: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  params: Record<string, unknown>;
  status: "dry_run" | "pending_approval" | "running" | "stopping" | "done" | "failed" | "stopped" | "undone";
  dryResult: { count: number; ms: number; sample: { id: string; label: string; before: Record<string, unknown>; after: Record<string, unknown> }[] } | null;
  reason: string | null;
  ticketRef: string | null;
  requestedBy: string;
  requestedById: string;
  approvedBy: string | null;
  approvalRequestId: string | null;
  undoOf: string | null;
  total: number | null;
  progress: number;
  changed: number;
  error: string | null;
  createdAt: string;
  hasChanges: boolean;
}
interface Overview {
  scripts: Script[];
  runs30: number;
  undone30: number;
  todo: Run[];
  canApprove: boolean;
}

const show = (v: Record<string, unknown>) => Object.values(v).map((x) => (x == null ? "—" : typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x) ? x.slice(0, 16).replace("T", " ") : String(x))).join(" · ");

/** ระบบ › สคริปต์ดูแลข้อมูล (O56 · storyboard เฟส 3 › Story 7) · Owner และวิศวกร */
export function ScriptsPage() {
  const t = useTranslations("scripts");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const { run } = useReauth();
  const me = useMe().data;
  const read = hasAny(me, "owner", "engineer");
  const [f, setF] = useUrlFilters({ tab: "scripts", script: "" });
  const tab = f.tab === "runs" ? "runs" : "scripts";
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const [offset, setOffset] = useState(0);
  const [rejecting, setRejecting] = useState<Run | null>(null);
  const [undoing, setUndoing] = useState<Run | null>(null);
  const o = useQuery({ queryKey: [...KEY, "overview"], queryFn: () => api.get<Overview>("/scripts"), enabled: read, refetchInterval: (q) => (q.state.data?.todo.some((r) => r.status === "running" || r.status === "stopping") ? 3000 : false) });
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(term ? { q: term } : {}) });
  const runs = useQuery({ queryKey: [...KEY, "runs", qs.toString()], queryFn: () => api.get<{ items: Run[]; total: number }>(`/scripts/runs?${qs}`), enabled: read && tab === "runs", placeholderData: keepPreviousData });
  const refresh = () => void cache.invalidateQueries({ queryKey: ["ops"] });
  const approve = useMutation({ mutationFn: (r: Run) => run(() => api.post(`/approvals/${r.approvalRequestId}/approve`, {}), t("approve")), onSuccess: () => (toast(t("approved")), refresh()), onError: (e) => toast(errorToast(e)) });
  const stop = useMutation({ mutationFn: (r: Run) => api.post(`/scripts/runs/${r.id}/stop`), onSuccess: () => (toast(t("stopped")), refresh()), onError: (e) => toast(errorToast(e)) });

  if (me && !read) return <NoAccess need={["owner", "engineer"]} mine={rolesOf(me)} />;
  const d = o.data;
  const name = (k: string) => t(`names.${k}` as "names.revoke_stale_sessions");
  const result = (r: Run) =>
    r.status === "running" || r.status === "stopping" ? t("progress", { done: fmt.num(r.progress), total: fmt.num(r.total ?? 0) }) : r.status === "done" ? (r.undoOf ? t("undoOfN", { n: r.changed }) : t("doneN", { n: fmt.num(r.changed) })) : t(`status.${r.status}`);
  return (
    <>
      <PageHead title={t("title")} desc={d ? t("desc", { count: d.scripts.length, runs: d.runs30, undone: d.undone30 }) : "…"} />
      <Notice tone="info">{t("note")}</Notice>
      {o.isPending ? (
        <TableSkeleton rows={2} cols={4} />
      ) : o.error ? (
        <ErrorBlock error={o.error} retry={() => void o.refetch()} />
      ) : (
        <TodoCard title={t("todo")} count={o.data.todo.length} hint={t("todoHint")} clear={{ title: t("clear"), description: t("clearNote") }}>
          {o.data.todo.map((r) => (
            <article key={r.id} className="todo-row" aria-label={name(r.scriptKey)}>
              <div className="todo-main">
                <b>{t("todoLine", { script: r.undoOf ? `${t("undo")} ${name(r.scriptKey)}` : name(r.scriptKey), workspace: r.workspaceName ?? "—", by: r.requestedBy })}</b>
                {r.reason && <span className="small">“{r.reason}”{r.ticketRef ? ` · ${r.ticketRef}` : ""}</span>}
                {r.dryResult && <span className="muted small">{t("dryLine", { n: fmt.num(r.dryResult.count) })}</span>}
              </div>
              <span className="todo-actions">
                {r.status === "pending_approval" ? (
                  <>
                    <Pill tone="warn">{t("status.pending_approval")}</Pill>
                    {o.data.canApprove && r.requestedById !== me?.id && (
                      <>
                        <Button size="small" onClick={() => setRejecting(r)}>
                          {t("reject")}
                        </Button>
                        <Button size="small" variant="primary" disabled={approve.isPending} onClick={() => approve.mutate(r)}>
                          {t("approve")}
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <span className="small">{result(r)}</span>
                    {r.status === "running" && (
                      <Button size="small" disabled={stop.isPending} onClick={() => stop.mutate(r)}>
                        {t("stop")}
                      </Button>
                    )}
                  </>
                )}
              </span>
            </article>
          ))}
        </TodoCard>
      )}
      <section className="card">
        <ListBar
          tabs={<Tabs label={t("tabs.label")} value={tab} onChange={(v) => setF({ tab: v })} tabs={[{ value: "scripts", label: <>{t("tabs.scripts")} {d && <span className="tab-count">{d.scripts.length}</span>}</> }, { value: "runs", label: t("tabs.runs") }]} />}
        >
          {tab === "runs" && (
            <div style={{ width: 240, flexShrink: 1, minWidth: 160 }}>
              <Input data-page-search type="search" aria-label={t("search")} placeholder={t("search")} value={search} onChange={(e) => (setSearch(e.target.value), setOffset(0))} />
            </div>
          )}
        </ListBar>
        {tab === "scripts" ? (
          !d ? (
            <TableSkeleton rows={3} cols={4} />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.script")}</th>
                    <th scope="col">{t("col.touches")}</th>
                    <th scope="col">{t("col.undo")}</th>
                    <th scope="col">{t("col.last")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("run")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.scripts.map((sc) => (
                    <tr key={sc.key}>
                      <td>
                        <span className="cell-strong">{name(sc.key)}</span>
                        <div className="cell-sub">{t(`descs.${sc.key}` as "descs.revoke_stale_sessions")}</div>
                      </td>
                      <td className="small">{t(`tables.${sc.table}` as "tables.issues")}</td>
                      <td>{sc.undoable ? <Pill tone="ok">{t("undoYes")}</Pill> : <Pill tone="bad">{t("undoNo")}</Pill>}</td>
                      <td className="small">{sc.lastRunAt ? fmt.date(sc.lastRunAt) : t("never")}</td>
                      <td className="num">
                        <Button size="small" onClick={() => setF({ script: sc.key })}>
                          {t("run")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : runs.isPending ? (
          <TableSkeleton rows={4} cols={5} />
        ) : runs.error ? (
          <ErrorBlock error={runs.error} retry={() => void runs.refetch()} />
        ) : !runs.data.items.length ? (
          <Empty title={t("empty")} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.time")}</th>
                    <th scope="col">{t("col.script")}</th>
                    <th scope="col">{t("col.ws")}</th>
                    <th scope="col">{t("col.who")}</th>
                    <th scope="col">{t("col.result")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("undo")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((r) => {
                    const sc = d?.scripts.find((x) => x.key === r.scriptKey);
                    return (
                      <tr key={r.id}>
                        <td className="small nowrap">{fmt.dateTime(r.createdAt)}</td>
                        <td>
                          {r.undoOf ? `${t("undo")} · ` : ""}
                          {name(r.scriptKey)}
                        </td>
                        <td>{r.workspaceName ?? "—"}</td>
                        <td className="small">
                          {r.requestedBy} / {r.approvedBy ?? "—"}
                        </td>
                        <td>
                          <Pill tone={r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "undone" ? "neu" : "inf"}>{result(r)}</Pill>
                          {r.error && <div className="cell-sub">{r.error}</div>}
                        </td>
                        <td className="num">
                          {r.status === "running" && (
                            <Button size="small" onClick={() => stop.mutate(r)}>
                              {t("stop")}
                            </Button>
                          )}
                          {sc?.undoable && (r.status === "done" || r.status === "stopped") && !r.undoOf && r.hasChanges && (
                            <Button size="small" variant="ghost" onClick={() => setUndoing(r)}>
                              {t("undo")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager offset={offset} limit={PAGE} shown={runs.data.items.length} total={runs.data.total} onChange={setOffset} />
          </>
        )}
      </section>
      {f.script && d?.scripts.some((x) => x.key === f.script) && <ScriptDrawer script={d.scripts.find((x) => x.key === f.script)!} onClose={() => setF({ script: "" })} />}
      {rejecting && <RejectDialog r={rejecting} name={name(rejecting.scriptKey)} onClose={() => setRejecting(null)} />}
      {undoing && <UndoDialog r={undoing} name={name(undoing.scriptKey)} onClose={() => setUndoing(null)} />}
    </>
  );
}

/** ขั้น 2 (storyboard): ใส่ค่า → ทดลองรัน (ไม่เขียนข้อมูล) → ขออนุมัติรันจริง (กดได้หลังทดลองและค่ายังไม่เปลี่ยน) */
function ScriptDrawer({ script, onClose }: { script: Script; onClose: () => void }) {
  const t = useTranslations("scripts");
  const td = useTranslations("scripts.drawer");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const [ws, setWs] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [wsSearch, setWsSearch] = useState("");
  const wsTerm = useDeferredValue(wsSearch.trim());
  const found = useQuery({ queryKey: ["ops", "ws-pick", wsTerm], queryFn: () => api.get<{ items: { id: string; name: string; slug: string }[] }>(`/workspaces?q=${encodeURIComponent(wsTerm)}&limit=6`), enabled: !ws && wsTerm.length >= 2 });
  const [values, setValues] = useState<Record<string, string>>({ days: script.key === "revoke_stale_sessions" ? "30" : "" });
  const [dry, setDry] = useState<{ run: Run; key: string } | null>(null);
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [confirm, setConfirm] = useState("");
  const params = Object.fromEntries(script.fields.filter((fl) => values[fl.key]).map((fl) => [fl.key, fl.kind === "number" ? Number(values[fl.key]) : values[fl.key]]));
  const key = JSON.stringify({ ws: ws?.id, params });
  const stale = !!dry && dry.key !== key;
  const doDry = useMutation({ mutationFn: () => api.post<Run>(`/scripts/${script.key}/dry-run`, { workspaceId: ws!.id, params }), onSuccess: (r) => setDry({ run: r, key }) });
  const request = useMutation({
    mutationFn: () => api.post(`/scripts/runs/${dry!.run.id}/request`, { reason: reason.trim(), ...(ticket.trim() ? { ticketRef: ticket.trim() } : {}), ...(script.undoable ? {} : { confirmSlug: confirm.trim() }) }),
    onSuccess: () => (toast(td("requested")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  const required = script.fields.filter((fl) => !fl.optional).every((fl) => values[fl.key]);
  const canRequest = !!dry && !stale && (dry.run.dryResult?.count ?? 0) > 0 && reason.trim().length >= 10 && (script.undoable || confirm.trim() === ws?.slug) && !request.isPending;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t(`names.${script.key}` as "names.revoke_stale_sessions")} description={t(`descs.${script.key}` as "descs.revoke_stale_sessions")} wide>
      <div className="stack">
        {ws ? (
          <div className="row">
            <span className="muted">{t("fields.workspace")}</span>
            <b>{ws.name}</b>
            <span className="muted mono small">{ws.slug}</span>
            <Button size="small" variant="ghost" onClick={() => (setWs(null), setDry(null))}>
              ✕
            </Button>
          </div>
        ) : (
          <div className="field">
            <Input label={t("fields.workspace")} placeholder={t("fields.wsSearch")} value={wsSearch} onChange={(e) => setWsSearch(e.target.value)} />
            {found.data?.items.map((w) => (
              <button key={w.id} type="button" className="menu-item" onClick={() => setWs(w)}>
                {w.name} · {w.slug}
              </button>
            ))}
          </div>
        )}
        {script.fields.map((fl) => (
          <Input
            key={fl.key}
            label={t(`fields.${fl.key}` as "fields.days")}
            type={fl.kind === "number" ? "number" : fl.kind === "date" ? "date" : "text"}
            min={fl.min}
            max={fl.max}
            value={values[fl.key] ?? ""}
            onChange={(e) => setValues({ ...values, [fl.key]: e.target.value })}
          />
        ))}
        <InlineError error={doDry.error} />
        <div className="row">
          <Button disabled={!ws || !required || doDry.isPending} onClick={() => doDry.mutate()}>
            {dry ? td("dryAgain") : td("dry")}
          </Button>
        </div>
        {dry?.run.dryResult && (
          <section className="stack-tight" aria-label={td("result", { ms: dry.run.dryResult.ms })}>
            <p className="muted small">{td("result", { ms: dry.run.dryResult.ms })}</p>
            <b>{dry.run.dryResult.count ? td("count", { n: fmt.num(dry.run.dryResult.count) }) : td("nothing")}</b>
            {!!dry.run.dryResult.sample.length && (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{td("colRow")}</th>
                      <th>{td("colBefore")}</th>
                      <th>{td("colAfter")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dry.run.dryResult.sample.map((s) => (
                      <tr key={s.id}>
                        <td className="small">{s.label}</td>
                        <td className="mono small">{show(s.before)}</td>
                        <td className="mono small">{show(s.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {stale && <Notice tone="warn">{td("changed")}</Notice>}
        {dry && !stale && (dry.run.dryResult?.count ?? 0) > 0 && (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), canRequest && request.mutate())}>
            <Textarea label={td("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Input label={td("ticket")} value={ticket} onChange={(e) => setTicket(e.target.value)} />
            {!script.undoable && ws && <Input label={td("confirm", { slug: ws.slug })} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            <InlineError error={request.error} />
            <div className="dialog-actions">
              <Button type="submit" variant="primary" disabled={!canRequest}>
                {td("request")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Drawer>
  );
}

function RejectDialog({ r, name, onClose }: { r: Run; name: string; onClose: () => void }) {
  const t = useTranslations("scripts");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/approvals/${r.approvalRequestId}/reject`, note.trim() ? { note: note.trim() } : {}), onSuccess: () => (toast(t("rejected")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("rejectTitle", { script: name })}>
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

function UndoDialog({ r, name, onClose }: { r: Run; name: string; onClose: () => void }) {
  const t = useTranslations("scripts");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: () => api.post(`/scripts/runs/${r.id}/undo`, { reason: reason.trim() }), onSuccess: () => (toast(t("undoSent")), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()) });
  const ok = reason.trim().length >= 10 && !m.isPending;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("undoTitle", { script: name })} description={t("undoNote")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Textarea label={tc("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ok}>
            {t("undo")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
