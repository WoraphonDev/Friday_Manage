"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ConfirmDialog } from "@/components/dialogs";
import { CopyButton, Drawer, Empty, ErrorBlock, Modal, Notice, Seg, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Input, Textarea, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { type Breach, type BreachDetail, localInput, type Risk } from "./types";
import { type PickedWs, WorkspacePicker } from "./WorkspacePicker";

const key = ["ops", "privacy", "breaches"] as const;
const invalidate = (cache: ReturnType<typeof useQueryClient>) => void cache.invalidateQueries({ queryKey: ["ops"] });
const riskTone: Record<Risk, string> = { low: "pill", medium: "pill warn", high: "pill bad" };

/** สถานะการแจ้ง สคส.: นับถอยหลัง 72 ชม. · ความเสี่ยงต่ำไม่ต้องแจ้ง */
function PdpcPill({ b }: { b: Breach }) {
  const t = useTranslations("pl.breach");
  const fmt = useFmt();
  if (b.pdpcNotifiedAt) return <span className="pill ok">{t("notified", { date: fmt.dateTime(b.pdpcNotifiedAt) })}</span>;
  if (!b.mustNotifyPdpc) return <span className="pill">{t("notRequired")}</span>;
  if (b.overdue) return <span className="pill bad">{t("overdue")}</span>;
  return <span className={(b.hoursLeft ?? 0) <= 24 ? "pill bad" : "pill warn"}>{t("hoursLeft", { n: b.hoursLeft ?? 0 })}</span>;
}

/** เหตุละเมิดข้อมูล (Owner / วิศวกร / ผู้ตรวจ) */
export function BreachesCard({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations("pl.breach");
  const fmt = useFmt();
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Breach[] }>("/privacy/breaches") });
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)" }}>
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("sub")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={6} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty ok title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["no", "found", "what", "risk", "pdpc", "status"] as const).map((c) => (
                  <th key={c}>{t(`col.${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <button type="button" className="link-button mono" onClick={() => onOpen(b.id)}>
                      #{b.number}
                    </button>
                  </td>
                  <td className="small">{fmt.dateTime(b.discoveredAt)}</td>
                  <td className="small" style={{ maxWidth: 360 }}>
                    {b.description}
                  </td>
                  <td>
                    <span className={riskTone[b.risk]}>{t(`risk.${b.risk}`)}</span>
                  </td>
                  <td>
                    <PdpcPill b={b} />
                  </td>
                  <td>
                    <span className={b.closedAt ? "pill ok" : "pill warn"}>{b.closedAt ? t("closed") : t("open")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** รายละเอียดเหตุ: ขั้นตอนตาม A4 · บันทึกความคืบหน้า · ร่างหนังสือ สคส. · Owner บันทึกการแจ้งและปิดเหตุ */
export function BreachDrawer({ id, canEdit, isOwner, onClose }: { id: string; canEdit: boolean; isOwner: boolean; onClose: () => void }) {
  const t = useTranslations("pl.breach");
  const fmt = useFmt();
  const q = useQuery({ queryKey: [...key, id], queryFn: () => api.get<BreachDetail>(`/privacy/breaches/${id}`) });
  const [modal, setModal] = useState<"update" | "draft" | "pdpc" | "subjects" | "close" | null>(null);
  const b = q.data?.breach;
  const open = b && !b.closedAt;
  const steps = b
    ? [
        { label: t("contained"), done: !!b.containedAt, note: b.containedAt ? fmt.dateTime(b.containedAt) : null },
        { label: t("assessed"), done: !!b.assessment, note: null },
        { label: t("pdpc"), done: !!b.pdpcNotifiedAt || !b.mustNotifyPdpc, note: b.mustNotifyPdpc ? null : t("notRequired") },
        { label: t("subjects"), done: !!b.subjectsNotifiedAt, note: b.subjectsNotifiedAt ? fmt.dateTime(b.subjectsNotifiedAt) : null },
      ]
    : [];
  const nowIdx = steps.findIndex((s) => !s.done);
  const canClose = b && !!b.assessment && (!b.mustNotifyPdpc || !!b.pdpcNotifiedAt);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={b ? `${t("title")} #${b.number}` : t("title")} description={b ? (b.mustNotifyPdpc ? t("deadline", { date: fmt.dateTime(b.pdpcDeadline) }) : t("notRequired")) : undefined}>
      {q.isPending ? (
        <TableSkeleton rows={5} cols={1} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="stack">
          <div className="row">
            <span className={riskTone[b!.risk]}>{t(`risk.${b!.risk}`)}</span>
            <PdpcPill b={b!} />
            <span className={b!.closedAt ? "pill ok" : "pill warn"}>{b!.closedAt ? t("closed") : t("open")}</span>
          </div>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{b!.description}</p>
          <table className="tbl">
            <tbody>
              <tr>
                <td className="muted">{t("dataTypes")}</td>
                <td>{b!.dataTypes.join(", ")}</td>
              </tr>
              <tr>
                <td className="muted">{t("affected")}</td>
                <td>{b!.affectedCount ?? t("unknown")}</td>
              </tr>
              <tr>
                <td className="muted">{t("workspaces")}</td>
                <td>{q.data.workspaces.map((w) => w.name).join(", ") || "—"}</td>
              </tr>
              {b!.containment && (
                <tr>
                  <td className="muted">{t("containment")}</td>
                  <td>{b!.containment}</td>
                </tr>
              )}
              {b!.assessment && (
                <tr>
                  <td className="muted">{t("assessment")}</td>
                  <td>{b!.assessment}</td>
                </tr>
              )}
            </tbody>
          </table>
          <section>
            <h3 className="card-title">{t("checklist")}</h3>
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={s.label} className={s.done ? "step-done" : open && i === nowIdx ? "step-now" : undefined}>
                  <span className="step-n">{i + 1}</span>
                  <span className="small">
                    {s.label}
                    {s.note && <span className="muted"> · {s.note}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {open && (canEdit || isOwner) && (
            <div className="row">
              {canEdit && <Button onClick={() => setModal("update")}>{t("update")}</Button>}
              {canEdit && b!.mustNotifyPdpc && <Button onClick={() => setModal("draft")}>{t("draft")}</Button>}
              {isOwner && b!.mustNotifyPdpc && !b!.pdpcNotifiedAt && (
                <Button variant="primary" onClick={() => setModal("pdpc")}>
                  {t("markPdpc")}
                </Button>
              )}
              {isOwner && !b!.subjectsNotifiedAt && <Button onClick={() => setModal("subjects")}>{t("markSubjects")}</Button>}
              {isOwner && (
                <Button variant="ghost" disabled={!canClose} title={canClose ? undefined : t("closeNeed")} onClick={() => setModal("close")}>
                  {t("close")}
                </Button>
              )}
            </div>
          )}
          {open && isOwner && !canClose && <p className="muted small">{t("closeNeed")}</p>}
          <details>
            <summary className="small">{t("log")}</summary>
            {q.data.log.map((l, i) => (
              <div key={i} className="small">
                <span className="muted">{fmt.dateTime(l.at)}</span> · {l.staffName ?? "—"} · {l.text}
              </div>
            ))}
          </details>
        </div>
      )}
      {b && modal === "update" && <UpdateBreach b={b} onClose={() => setModal(null)} />}
      {b && modal === "draft" && <PdpcDraft b={b} onClose={() => setModal(null)} />}
      {b && (modal === "pdpc" || modal === "subjects" || modal === "close") && <MarkBreach b={b} kind={modal} onClose={() => setModal(null)} />}
    </Drawer>
  );
}

function UpdateBreach({ b, onClose }: { b: Breach; onClose: () => void }) {
  const t = useTranslations("pl.breach");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [risk, setRisk] = useState<Risk>(b.risk);
  const [affected, setAffected] = useState(b.affectedCount == null ? "" : String(b.affectedCount));
  const [containment, setContainment] = useState(b.containment ?? "");
  const [containedAt, setContainedAt] = useState(b.containedAt ? localInput(new Date(b.containedAt)) : "");
  const [assessment, setAssessment] = useState(b.assessment ?? "");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.patch(`/privacy/breaches/${b.id}`, {
        note: note.trim(),
        ...(risk !== b.risk ? { risk } : {}),
        ...(affected !== "" && Number(affected) !== b.affectedCount ? { affectedCount: Number(affected) } : {}),
        ...(containment.trim() && containment.trim() !== b.containment ? { containment: containment.trim() } : {}),
        ...(containedAt && !b.containedAt ? { containedAt: new Date(containedAt).toISOString() } : {}),
        ...(assessment.trim() && assessment.trim() !== b.assessment ? { assessment: assessment.trim() } : {}),
      }),
    onSuccess: () => (toast(t("saved")), invalidate(cache), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${t("update")} · #${b.number}`}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), note.trim().length >= 3 && m.mutate())}>
        <div className="field">
          <span className="field-label">{t("col.risk")}</span>
          <Seg label={t("col.risk")} value={risk} onChange={setRisk} options={(["low", "medium", "high"] as const).map((v) => ({ value: v, label: t(`risk.${v}`) }))} />
        </div>
        <div className="grid-2">
          <Input label={t("affected")} type="number" min={0} value={affected} onChange={(e) => setAffected(e.target.value)} />
          <Input label={t("containedAt")} type="datetime-local" value={containedAt} disabled={!!b.containedAt} onChange={(e) => setContainedAt(e.target.value)} />
        </div>
        <Textarea label={t("containment")} value={containment} onChange={(e) => setContainment(e.target.value)} />
        <Textarea label={t("assessment")} value={assessment} onChange={(e) => setAssessment(e.target.value)} />
        <Input label={t("note")} value={note} onChange={(e) => setNote(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={note.trim().length < 3 || m.isPending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PdpcDraft({ b, onClose }: { b: Breach; onClose: () => void }) {
  const t = useTranslations("pl.breach");
  const fmt = useFmt();
  const q = useQuery({ queryKey: [...key, b.id, "draft"], queryFn: () => api.get<{ text: string; deadline: string }>(`/privacy/breaches/${b.id}/pdpc-draft`) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("draftTitle")} description={t("draftDesc", { date: fmt.dateTime(b.pdpcDeadline) })} className="dialog-wide">
      <div className="dialog-body">
        {q.isPending ? (
          <TableSkeleton rows={6} cols={1} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : (
          <>
            <pre className="diff" style={{ fontFamily: "inherit" }}>
              {q.data.text}
            </pre>
            <div className="dialog-actions">
              <CopyButton text={q.data.text} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Owner: บันทึกว่าแจ้ง สคส. / แจ้ง Owner และเจ้าของข้อมูล / ปิดเหตุ · ทุกครั้งต้องมีบันทึก */
function MarkBreach({ b, kind, onClose }: { b: Breach; kind: "pdpc" | "subjects" | "close"; onClose: () => void }) {
  const t = useTranslations("pl.breach");
  const toast = useToast();
  const cache = useQueryClient();
  const path = { pdpc: "pdpc-notified", subjects: "subjects-notified", close: "close" }[kind];
  const title = { pdpc: t("markPdpcTitle", { n: b.number }), subjects: t("markSubjectsTitle", { n: b.number }), close: t("closeTitle", { n: b.number }) }[kind];
  const [notify, setNotify] = useState(true);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={kind === "pdpc" && b.overdue ? t("pdpcLate") : undefined}
      reasonLabel={t("markLabel")}
      onConfirm={async ({ reason }) => {
        const res = await api.post<{ sent?: number }>(`/privacy/breaches/${b.id}/${path}`, { note: reason, ...(kind === "subjects" ? { notifyOwners: notify } : {}) });
        toast(kind === "subjects" && notify ? t("sentOwners", { n: res.sent ?? 0 }) : t("marked"));
        invalidate(cache);
      }}
    >
      {kind === "subjects" && b.workspaceIds.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>{t("notifyOwners")}</span>
        </label>
      )}
    </ConfirmDialog>
  );
}

/** A4 · แจ้งเหตุละเมิดข้อมูล (Drawer) · นับ 72 ชม. จากเวลาที่รู้ */
export function NewBreach({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("pl.a4");
  const tb = useTranslations("pl.breach");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [found, setFound] = useState(localInput());
  const [what, setWhat] = useState("");
  const [types, setTypes] = useState("");
  const [affected, setAffected] = useState("");
  const [ws, setWs] = useState<PickedWs[]>([]);
  const [risk, setRisk] = useState<Risk>("medium");
  const [containment, setContainment] = useState("");
  const [containedAt, setContainedAt] = useState("");
  const dataTypes = types
    .split(/[,،、]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const ok = !!found && what.trim().length >= 10 && dataTypes.length > 0;
  const left = Date.parse(found) + 72 * 3_600_000 - Date.now();
  const clock = left > 0 ? `${Math.floor(left / 3_600_000)}:${String(Math.floor((left % 3_600_000) / 60_000)).padStart(2, "0")}` : null;
  const m = useMutation({
    mutationFn: () =>
      api.post<Breach>("/privacy/breaches", {
        discoveredAt: new Date(found).toISOString(),
        description: what.trim(),
        dataTypes,
        workspaceIds: ws.map((w) => w.id),
        risk,
        ...(affected !== "" ? { affectedCount: Number(affected) } : {}),
        ...(containment.trim() ? { containment: containment.trim() } : {}),
        ...(containedAt ? { containedAt: new Date(containedAt).toISOString() } : {}),
      }),
    onSuccess: (b) => (toast(t("done", { n: b.number })), invalidate(cache), onCreated(b.id)),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t("title")} description={clock ? t("clock", { time: clock }) : t("clockOver")}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), ok && m.mutate())}>
        <Input label={t("found")} type="datetime-local" max={localInput()} value={found} onChange={(e) => setFound(e.target.value)} />
        <Textarea label={t("what")} value={what} onChange={(e) => setWhat(e.target.value)} />
        <div className="grid-2">
          <Input label={t("dataTypes")} hint={t("dataTypesHint")} value={types} onChange={(e) => setTypes(e.target.value)} />
          <Input label={t("affected")} type="number" min={0} value={affected} onChange={(e) => setAffected(e.target.value)} />
        </div>
        <WorkspacePicker label={t("ws")} placeholder={tb("workspaces")} value={ws} onChange={setWs} />
        <div className="field">
          <span className="field-label">{t("risk")}</span>
          <Seg label={t("risk")} value={risk} onChange={setRisk} options={(["low", "medium", "high"] as const).map((v) => ({ value: v, label: tb(`risk.${v}`) }))} />
        </div>
        <Textarea label={t("containment")} value={containment} onChange={(e) => setContainment(e.target.value)} />
        <Input label={t("containedAt")} type="datetime-local" value={containedAt} onChange={(e) => setContainedAt(e.target.value)} />
        <Notice tone="info" title={t("note")} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!ok || m.isPending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
