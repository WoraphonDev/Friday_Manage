"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, Dialog, ErrorState, Input, LoadingState, Select, useToast } from "@/components/ui";
import { PositionPicker } from "@/features/positions/position-picker";
import { api } from "@/lib/api";
import { jobTitleCodes } from "@/lib/positions";
import type { Project } from "@/lib/types";
import type { WorkspaceMember } from "../../p/[key]/members/_components/types";
import styles from "./ws.module.css";

/** เรื่องที่ 1 ใน storyboard (ผู้ใช้เลือก 2026-11-16): แก้ตำแหน่ง แผนก และ Capacity จากหน้า Workspace members */
export function EditMemberDialog({ ws, member, projects, onClose, onDone }: { ws: string; member: WorkspaceMember; projects: Project[]; onClose: () => void; onDone: () => Promise<void> }) {
  const t = useTranslations("members-workload.ws.edit");
  const tc = useTranslations("common.app");
  const toast = useToast();
  const [positions, setPositions] = useState(() => jobTitleCodes(member.jobTitle));
  const [apply, setApply] = useState(true);
  const [department, setDepartment] = useState(member.department ?? "");
  const [capacity, setCapacity] = useState(String(member.capacityHoursWeek));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const hours = Number(capacity);
  const capacityError = capacity.trim() === "" || !Number.isInteger(hours) || hours < 0 || hours > 80 ? t("capacityRange") : "";

  async function save() {
    if (capacityError) return;
    setPending(true);
    setError("");
    try {
      await api.request(`/w/${encodeURIComponent(ws)}/members/${member.userId}`, {
        method: "PATCH",
        body: { positions, applyToProjects: apply && projects.length > 0, department: department.trim() || null, capacityHoursWeek: hours },
      });
      toast({ message: t("saved", { name: member.displayName }) });
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : tc("unknownError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={t("title", { name: member.displayName })} description={member.email}>
      <div className={styles.form}>
        <PositionPicker label={t("positions")} value={positions} onChange={setPositions} />
        {projects.length > 0 && (
          <label className={styles.check}>
            <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
            <span>
              {t("apply")}
              <small>{projects.map((p) => p.name).join(" · ")}</small>
            </span>
          </label>
        )}
        <div className={styles.two}>
          <Input label={t("department")} value={department} maxLength={80} placeholder={t("optional")} onChange={(e) => setDepartment(e.target.value)} />
          <Input label={t("capacity")} type="number" min={0} max={80} value={capacity} error={capacityError || undefined} onChange={(e) => setCapacity(e.target.value)} />
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button disabled={pending} onClick={onClose}>{tc("cancel")}</Button>
          <Button variant="primary" disabled={pending || !!capacityError} onClick={() => void save()}>{pending ? tc("saving") : tc("save")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

interface HandoverProject {
  id: string;
  key: string;
  name: string;
  color: string | null;
  open: number;
  md: number;
  overdue: number;
  canTransfer: boolean;
  items: { key: string; title: string; planEnd: string | null }[];
  candidates: { userId: string; displayName: string }[];
}
interface Handover {
  assignedIssues: { total: number };
  ownedProjects: { key: string; name: string }[];
  overdue: number;
  projects: HandoverProject[];
}
/** ค่าในช่อง "ส่งต่องานให้" · KEEP = คงชื่อเดิม · NONE = ไม่ระบุผู้รับผิดชอบ · นอกนั้น = userId */
const KEEP = "";
const NONE = "none";

/** เรื่องที่ 2 ใน storyboard: ปิดการใช้งาน · สรุปเป็นตัวเลข แล้วเลือกคนรับงานทีละโปรเจกต์ (API ย้ายงานในธุรกรรมเดียวกับการปิด) */
export function DeactivateDialog({ ws, member, onClose, onDone }: { ws: string; member: WorkspaceMember; onClose: () => void; onDone: () => Promise<void> }) {
  const t = useTranslations("members-workload.ws.off");
  const tc = useTranslations("common.app");
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/members/${member.userId}`;
  const [to, setTo] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const handover = useQuery({ queryKey: ["handover", ws, member.userId], queryFn: () => api.get<Handover>(`${base}/handover`), gcTime: 0 });

  async function deactivate() {
    const h = handover.data!;
    const transfers = h.projects.filter((p) => (to[p.id] ?? KEEP) !== KEEP).map((p) => ({ projectId: p.id, to: to[p.id] === NONE ? null : to[p.id] }));
    setPending(true);
    setError("");
    try {
      const r = await api.post<{ transferred: { count: number }[] }>(`${base}/deactivate`, { transfers });
      const moved = r.transferred.reduce((sum, x) => sum + x.count, 0);
      toast({ message: moved ? t("doneMoved", { count: moved, name: member.displayName }) : t("done", { name: member.displayName }) });
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : tc("unknownError"));
    } finally {
      setPending(false);
    }
  }

  const h = handover.data;
  const listed = h ? h.projects.reduce((sum, p) => sum + p.open, 0) : 0;
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={t("title", { name: member.displayName })} description={member.email} size="medium">
      <div className={styles.form}>
        {handover.isPending ? (
          <LoadingState />
        ) : handover.error ? (
          <ErrorState error={handover.error} retry={() => handover.refetch()} />
        ) : (
          <>
            <div className={styles.stats}>
              <div><b>{h!.assignedIssues.total}</b><span>{t("open")}</span></div>
              <div><b>{h!.projects.length}</b><span>{t("projects")}</span></div>
              <div><b>{h!.overdue}</b><span>{t("overdue")}</span></div>
            </div>
            {h!.projects.length > 0 ? (
              <section className={styles.handover} aria-label={t("handTo")}>
                <div className={styles.label}>{t("handTo")}</div>
                <ul className={styles.projects}>
                  {h!.projects.map((p) => (
                    <li key={p.id}>
                      <div className={styles.projectRow}>
                        <span className={styles.dot} style={{ background: p.color ?? "var(--muted)" }} aria-hidden="true" />
                        <span className={styles.projectName}>
                          <b>{p.name}</b>
                          <small>{t("count", { count: p.open, md: p.md })}</small>
                          <button type="button" className={styles.link} aria-expanded={shown === p.id} onClick={() => setShown(shown === p.id ? null : p.id)}>
                            {shown === p.id ? t("hideList") : t("showList")}
                          </button>
                        </span>
                        <Select
                          size="small"
                          aria-label={t("handToProject", { name: p.name })}
                          value={to[p.id] ?? KEEP}
                          disabled={!p.canTransfer}
                          onChange={(e) => setTo({ ...to, [p.id]: e.target.value })}
                        >
                          <option value={KEEP}>{t("keep")}</option>
                          <option value={NONE}>{t("unassign")}</option>
                          {p.candidates.map((c) => <option key={c.userId} value={c.userId}>{c.displayName}</option>)}
                        </Select>
                      </div>
                      {!p.canTransfer && <p className={styles.hint}>{t("noPermission")}</p>}
                      {shown === p.id && (
                        <ul className={styles.issues}>
                          {p.items.map((i) => <li key={i.key}><b>{i.key}</b> {i.title}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                {h!.assignedIssues.total > listed && <p className={styles.hint}>{t("hidden", { count: h!.assignedIssues.total - listed })}</p>}
              </section>
            ) : (
              <p className={styles.hint}>{t("none")}</p>
            )}
            {h!.ownedProjects.length > 0 && <div className={styles.warn}>{t("owner", { name: member.displayName, projects: h!.ownedProjects.map((p) => p.name).join(", ") })}</div>}
            <p className={styles.hint}>{t("hint")}</p>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button disabled={pending} onClick={onClose}>{tc("cancel")}</Button>
              <Button variant="danger" disabled={pending} onClick={() => void deactivate()}>{pending ? t("working") : t("confirm", { name: member.displayName })}</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
