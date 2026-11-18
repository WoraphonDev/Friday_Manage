"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Modal, Seg } from "@/components/kit";
import { Button, errorToast, InlineError, Input, Select, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { defer, UNDO_MS } from "@/lib/outbox";
import { useSupportStaff } from "@/lib/staff-options";
import styles from "../../workspaces/_parts/bulk.module.css";
import { CANNED_KEY, type Canned, PRIORITIES } from "../settings/_parts/types";
import { useOpenIncidents } from "./filters";

/**
 * ทำกับ Ticket ทีละหลายเรื่อง (ช่วง 3) · ตรงกับ ops-api › support/bulk.service
 * ถึงลูกค้า (ตอบ / ปิดเรื่อง): ดูตัวอย่าง → พิมพ์จำนวนเรื่อง → ส่งทันที (ย้อนไม่ได้)
 * ไม่ถึงลูกค้า (โอน / ความสำคัญ / ผูกเหตุขัดข้อง / บันทึกภายใน): ทำหลัง 10 วินาที กดย้อนกลับได้
 */
export type BulkTarget = { ids: string[] } | { filter: Record<string, string> };
export type BulkKind = "reply" | "assign" | "solve" | "priority" | "incident";
type Action =
  | { type: "reply"; body: string; internal: boolean; solve?: { cause: string; sendCsat: boolean } }
  | { type: "assign"; staffId: string }
  | { type: "solve"; outcome: string; cause: string; sendCsat: boolean }
  | { type: "priority"; priority: string }
  | { type: "incident"; incidentId: string | null };
interface Skip {
  id: string;
  number: number;
  reason: string;
  message: string;
}
interface Preview {
  total: number;
  eligible: number;
  skipped: Skip[];
  customerFacing: boolean;
  sample: { number: number; subject: string; body: string } | null;
}
export interface BulkJob {
  id: string;
  action: BulkKind;
  total: number;
  done: number;
  ok: { id: string; number: number }[];
  skipped: Skip[];
  failed: { id: string; number: number; message: string }[];
  status: "running" | "done";
}

const KINDS: BulkKind[] = ["reply", "assign", "solve", "priority", "incident"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** รอจนงานเสร็จ (ถามทุก 0.7 วินาที) */
async function follow(id: string, onTick?: (j: BulkJob) => void) {
  for (;;) {
    const j = await api.get<BulkJob>(`/tickets/bulk/${id}`);
    onTick?.(j);
    if (j.status === "done") return j;
    await sleep(700);
  }
}
/** ผลเป็น CSV (ส่งต่อหัวหน้า / เก็บหลักฐาน) */
function downloadCsv(job: BulkJob, label: (r: "ok" | "skipped" | "failed") => string) {
  const rows = [
    ["ticket", "result", "detail"],
    ...job.ok.map((x) => [`#${x.number}`, label("ok"), ""]),
    ...job.skipped.map((x) => [`#${x.number}`, label("skipped"), x.message]),
    ...job.failed.map((x) => [`#${x.number}`, label("failed"), x.message]),
  ];
  const csv = "﻿" + rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `tickets-bulk-${job.id.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function BulkDialog({ target, count, initial = "reply", onClose, onDone }: { target: BulkTarget; count: number; initial?: BulkKind; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("ss.support.bulk");
  const ts = useTranslations("ss.support");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const staff = useSupportStaff();
  const incidents = useOpenIncidents();
  const canned = useQuery({ queryKey: [...CANNED_KEY, false], queryFn: () => api.get<{ items: Canned[] }>("/support/canned-replies") });
  const [kind, setKind] = useState<BulkKind>(initial);
  const [body, setBody] = useState("");
  const [cannedId, setCannedId] = useState("");
  const [internal, setInternal] = useState(false);
  const [solveAfter, setSolveAfter] = useState(false);
  const [cause, setCause] = useState("");
  const [sendCsat, setSendCsat] = useState(true);
  const [staffId, setStaffId] = useState("");
  const [priority, setPriority] = useState("high");
  const [incidentId, setIncidentId] = useState("");
  const [typed, setTyped] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<BulkJob | null>(null);
  // เปลี่ยนเนื้อหาแล้วตัวอย่างเดิมใช้ไม่ได้
  useEffect(() => (setPreview(null), setTyped("")), [kind, body, internal, solveAfter, cause, sendCsat, staffId, priority, incidentId]);
  const action = (): Action =>
    kind === "reply"
      ? { type: "reply", body, internal, ...(solveAfter && !internal ? { solve: { cause, sendCsat } } : {}) }
      : kind === "assign"
        ? { type: "assign", staffId }
        : kind === "solve"
          ? { type: "solve", outcome: body, cause, sendCsat }
          : kind === "priority"
            ? { type: "priority", priority }
            : { type: "incident", incidentId: incidentId === "none" ? null : incidentId };
  const ready =
    kind === "reply" ? body.trim().length > 0 && (!solveAfter || internal || cause.trim().length >= 3) : kind === "solve" ? body.trim().length >= 3 && cause.trim().length >= 3 : kind === "assign" ? !!staffId : kind === "incident" ? !!incidentId : true;
  const check = useMutation({ mutationFn: () => api.post<Preview>("/tickets/bulk/preview", { ...target, action: action() }), onSuccess: setPreview });
  const refresh = () => cache.invalidateQueries({ queryKey: ["ops", "tickets"] });
  const label = (r: "ok" | "skipped" | "failed") => t(`result.${r}`);
  // ถึงลูกค้า: ส่งทันทีหลังพิมพ์จำนวน แล้วดูความคืบหน้าในหน้าต่างนี้
  const send = useMutation({
    mutationFn: async () => {
      const j = await api.post<BulkJob>("/tickets/bulk", { ...target, action: action(), confirmCount: preview!.eligible });
      if (cannedId) void api.post(`/support/canned-replies/${cannedId}/use`, {}).catch(() => undefined);
      setJob(j);
      return follow(j.id, setJob);
    },
    onSuccess: () => void refresh(),
  });
  // ไม่ถึงลูกค้า: ปิดหน้าต่าง · ทำหลัง 10 วินาที · กดย้อนกลับได้
  const later = () => {
    const a = action();
    const n = preview!.eligible;
    const run = defer(
      `tickets-bulk:${Date.now()}`,
      async () => {
        const j = await api.post<BulkJob>("/tickets/bulk", { ...target, action: a });
        const done = await follow(j.id);
        void refresh();
        toast({ message: t("doneToast", { ok: done.ok.length, skipped: done.skipped.length, failed: done.failed.length }), tone: done.failed.length ? "error" : "ok" });
      },
      (e) => toast(errorToast(e)),
    );
    toast({ message: t("queued", { n, action: t(`kinds.${kind}`) }), duration: UNDO_MS, undo: () => run.cancel() && toast(t("undone")) });
    onDone();
  };
  const facing = preview?.customerFacing ?? (kind === "solve" || (kind === "reply" && !internal));
  const confirmOk = !!preview && typed.trim() === String(preview.eligible);
  return (
    <Modal open onOpenChange={(o) => !o && !send.isPending && (job?.status === "done" ? onDone() : onClose())} title={t("title", { n: count })} description={t("desc")} className={styles.dialog}>
      {job ? (
        <div className="dialog-body">
          <p aria-live="polite">
            {job.status === "done" ? t("finished") : t("progress", { done: job.done, total: job.total })}
          </p>
          <progress max={job.total} value={job.done} style={{ width: "100%" }} aria-label={t("progressLabel")} />
          <p className="small">{t("summary", { ok: job.ok.length, skipped: job.skipped.length, failed: job.failed.length })}</p>
          {job.failed.length > 0 && (
            <ul className="small">
              {job.failed.slice(0, 10).map((x) => (
                <li key={x.id}>
                  #{x.number} · {x.message}
                </li>
              ))}
            </ul>
          )}
          <InlineError error={send.error} />
          <div className="dialog-actions">
            <Button type="button" disabled={job.status !== "done"} onClick={() => downloadCsv(job, label)}>
              {t("csv")}
            </Button>
            <Button type="button" variant="primary" disabled={job.status !== "done"} onClick={onDone}>
              {tc("close")}
            </Button>
          </div>
        </div>
      ) : (
        <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), ready && check.mutate())}>
          <Seg label={t("what")} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))} />
          {(kind === "reply" || kind === "solve") && (
            <>
              {kind === "reply" && (
                <Select
                  label={t("canned")}
                  value={cannedId}
                  onChange={(e) => {
                    setCannedId(e.target.value);
                    const c = canned.data?.items.find((x) => x.id === e.target.value);
                    if (c) setBody(c.body);
                  }}
                >
                  <option value="">{t("cannedNone")}</option>
                  {(canned.data?.items ?? [])
                    .filter((c) => !c.archivedAt)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                </Select>
              )}
              <Textarea label={kind === "solve" ? t("outcome") : t("body")} hint={t("vars")} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
              {kind === "reply" && (
                <label className="check">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  <span>{t("internal")}</span>
                </label>
              )}
              {kind === "reply" && !internal && (
                <label className="check">
                  <input type="checkbox" checked={solveAfter} onChange={(e) => setSolveAfter(e.target.checked)} />
                  <span>{t("solveAfter")}</span>
                </label>
              )}
              {(kind === "solve" || (solveAfter && !internal)) && (
                <>
                  <Input label={t("cause")} value={cause} onChange={(e) => setCause(e.target.value)} />
                  <label className="check">
                    <input type="checkbox" checked={sendCsat} onChange={(e) => setSendCsat(e.target.checked)} />
                    <span>{t("csat")}</span>
                  </label>
                </>
              )}
            </>
          )}
          {kind === "assign" && (
            <Select label={t("assignTo")} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">{t("pick")}</option>
              {staff.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
          {kind === "priority" && (
            <Select label={t("priority")} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {ts(`priority.${p}`)}
                </option>
              ))}
            </Select>
          )}
          {kind === "incident" && (
            <Select label={t("incident")} value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
              <option value="">{t("pick")}</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
              <option value="none">{t("unlink")}</option>
            </Select>
          )}
          {preview && (
            <section className={styles.panel} aria-label={t("previewLabel")}>
              <div className={styles.panelHead}>{t("previewHead", { eligible: preview.eligible, total: preview.total })}</div>
              <div className={styles.panelBody}>
                {preview.sample && (
                  <div>
                    <div className="muted small">{t("sample", { number: preview.sample.number })}</div>
                    <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{preview.sample.body}</p>
                  </div>
                )}
                {preview.skipped.length > 0 && (
                  <div className="small">
                    <b>{t("skipped", { n: preview.skipped.length })}</b>
                    <ul style={{ margin: "4px 0 0" }}>
                      {preview.skipped.slice(0, 8).map((x) => (
                        <li key={x.id}>
                          #{x.number} · {x.message}
                        </li>
                      ))}
                      {preview.skipped.length > 8 && <li>{t("more", { n: preview.skipped.length - 8 })}</li>}
                    </ul>
                  </div>
                )}
                {facing && preview.eligible > 0 && <Input label={t("typeCount", { n: preview.eligible })} inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} hint={t("noUndo")} />}
              </div>
            </section>
          )}
          <InlineError error={check.error ?? send.error} />
          <div className="dialog-actions">
            <Button type="button" onClick={onClose}>
              {tc("cancel")}
            </Button>
            {!preview ? (
              <Button type="submit" variant="primary" disabled={!ready || check.isPending}>
                {t("check")}
              </Button>
            ) : facing ? (
              <Button type="button" variant="primary" disabled={!confirmOk || send.isPending || preview.eligible === 0} onClick={() => send.mutate()}>
                {t("sendNow", { n: preview.eligible })}
              </Button>
            ) : (
              <Button type="button" variant="primary" disabled={preview.eligible === 0} onClick={later}>
                {t("doIt", { n: preview.eligible })}
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}

/** ผูก / เลิกผูกเหตุขัดข้องของเรื่องเดียว (หัวแผง Ticket) · ไม่ถึงลูกค้า */
export function IncidentLink({ ticketId, incident, canEdit }: { ticketId: string; incident: { id: string; title: string } | null; canEdit: boolean }) {
  const t = useTranslations("ss.support.bulk");
  const toast = useToast();
  const cache = useQueryClient();
  const incidents = useOpenIncidents();
  const m = useMutation({
    mutationFn: (incidentId: string | null) => api.put(`/tickets/${ticketId}/incident`, { incidentId }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["ops", "tickets"] }),
    onError: (e) => toast(errorToast(e)),
  });
  if (incident)
    return (
      <span className="row nowrap" style={{ gap: 6 }}>
        <span className="pill inf">{t("incidentPill", { title: incident.title })}</span>
        {canEdit && (
          <button type="button" className="link-button small" disabled={m.isPending} onClick={() => m.mutate(null)}>
            {t("unlinkShort")}
          </button>
        )}
      </span>
    );
  if (!canEdit || !incidents.length) return null;
  return (
    <select className="input" style={{ width: "auto" }} aria-label={t("linkIncident")} value="" disabled={m.isPending} onChange={(e) => e.target.value && m.mutate(e.target.value)}>
      <option value="">{t("linkIncident")}</option>
      {incidents.map((i) => (
        <option key={i.id} value={i.id}>
          {i.title}
        </option>
      ))}
    </select>
  );
}
