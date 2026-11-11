"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ConfirmDialog, ConflictState, Dialog, ErrorState, Forbidden, Input, LoadingState, NotFound, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { WorkflowSection } from "./workflow-section";
import { ModulesSection, TypesSection } from "./structure-sections";
import { PermsSection } from "./perms-section";
import {
  BASELINE_SECTIONS, DEFAULT_SIZE_MD, errorText, isForbidden, isSection, SECTIONS, SIZES,
  type DeleteImpact, type HolidayCalendar, type Member, type ProjectDetail, type Section, type Size,
} from "./types";
import { membersKey, projectEndpoint, SectionHead } from "./shared";
import { PlanIoContent } from "@/features/plan-io/plan-io";
import styles from "./settings.module.css";


export function ProjectSettings({ ws, projectKey, section }: { ws: string; projectKey: string; section?: string }) {
  const t = useTranslations("project-settings-new.settings");
  const base = projectEndpoint(ws, projectKey);
  const href = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  // ใช้ cache key เดียวกับ ProjectShell เพื่อให้หัวหน้าเปลี่ยนตามทันทีหลังบันทึก
  const project = useQuery({ queryKey: queryKeys.project(ws, projectKey), queryFn: () => api.get<ProjectDetail>(base) });
  const canEdit = !!perms.data?.permissions.includes("project.settings");
  const members = useQuery({ queryKey: membersKey(ws, projectKey), queryFn: () => api.get<{ items: Member[] }>(`${base}/members`), enabled: canEdit });

  const current: Section | null = section === undefined ? "general" : isSection(section) ? section : null;
  if (!current) return <NotFound />;
  const error = perms.error ?? project.error;
  if (isForbidden(error)) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => { void perms.refetch(); void project.refetch(); }} />;
  if (!perms.data || !project.data) return <LoadingState />;
  // Guest และคนที่ไม่มี project.settings ไม่เห็น Settings (04-permissions ข้อ 4)
  if (!canEdit || perms.data.guestViewer) return <Forbidden />;

  const p = project.data;
  const canBaseline = perms.data.permissions.includes("project.baseline");
  if (BASELINE_SECTIONS.includes(current) && !canBaseline) return <Forbidden />;
  const nav = <SettingsNav ws={ws} projectKey={projectKey} current={current} canAutomation={perms.data.permissions.includes("project.automation")} canBaseline={canBaseline} />;
  // Import / Export / การแก้ไขแผน: เนื้อหามีการ์ดของตัวเอง จึงไม่ซ้อนในกล่อง panel
  if (current === "import" || current === "export" || current === "plan-changes") {
    return (
      <div className={styles.body}>
        {nav}
        <div className={styles.frameMain}>
          <PlanIoContent ws={ws} projectKey={projectKey} section={current === "plan-changes" ? "changes" : current} changesHref={`${href}/settings/plan-changes`} />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.body}>
      {nav}
      <section className={`${styles.card} ${styles.panel}`} aria-labelledby="settings-heading">
        {current === "general" && <GeneralSection key={p.version} ws={ws} projectKey={projectKey} project={p} members={members.data?.items ?? []} />}
        {current === "workflow" && <WorkflowSection ws={ws} projectKey={projectKey} project={p} />}
        {current === "types" && <TypesSection ws={ws} projectKey={projectKey} />}
        {current === "modules" && <ModulesSection ws={ws} projectKey={projectKey} members={members.data?.items ?? []} />}
        {current === "perms" && <PermsSection ws={ws} projectKey={projectKey} />}
        {(current === "notify" || current === "integ") && <ClosedSection section={current} />}
        {current === "danger" && <DangerSection ws={ws} projectKey={projectKey} project={p} access={perms.data} members={members.data?.items ?? []} />}
      </section>
    </div>
  );
}

/** เมนูซ้ายของ Settings · ใช้ร่วมกับหน้า Automation ให้เมนูไม่หายเมื่อเลือก Automation */
export function SettingsNav({ ws, projectKey, current, canAutomation, canBaseline = true }: { ws: string; projectKey: string; current: Section | "automation"; canAutomation: boolean; canBaseline?: boolean }) {
  const t = useTranslations("project-settings-new.settings");
  const href = `/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  return (
    <nav className={`${styles.card} ${styles.nav}`} aria-label={t("navLabel")}>
      {SECTIONS.filter((s) => canBaseline || !BASELINE_SECTIONS.includes(s)).map((s) => (
        <Link key={s} href={`${href}/settings/${s}`} className={`${styles.snav} ${s === "danger" ? styles.danger : ""}`} aria-current={s === current ? "page" : undefined}>
          {t(`nav.${s}`)}
        </Link>
      ))}
      {canAutomation && (
        <Link href={`${href}/automation`} className={styles.snav} aria-current={current === "automation" ? "page" : undefined}>
          {t("nav.automation")} <span className={styles.tag}>Team</span>
        </Link>
      )}
    </nav>
  );
}

/** โครง Settings (เมนูซ้าย + เนื้อหา) สำหรับหน้าที่อยู่นอก route settings เช่น Automation */
export function SettingsFrame({ ws, projectKey, current, canAutomation, children }: { ws: string; projectKey: string; current: Section | "automation"; canAutomation: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.body}>
      <SettingsNav ws={ws} projectKey={projectKey} current={current} canAutomation={canAutomation} />
      <div className={styles.frameMain}>{children}</div>
    </div>
  );
}

/** แท็บที่ API ยังไม่มี (03-api › 3.5 p/notification-rules, p/repositories) แสดงว่ายังไม่เปิด แทนการทำหน้าปลอม */
function ClosedSection({ section }: { section: "notify" | "integ" }) {
  const t = useTranslations("project-settings-new.settings");
  return (
    <>
      <SectionHead title={t(`${section}.title`)} description={t(`${section}.description`)} />
      <div className={styles.closed} role="status">
        <b>{t("closed.title")}</b>
        <span className={styles.muted}>{t(`${section}.closed`)}</span>
      </div>
    </>
  );
}

type GeneralForm = {
  name: string;
  key: string;
  startDate: string;
  goliveDate: string;
  visibility: ProjectDetail["visibility"];
  estimateUnit: ProjectDetail["estimateUnit"];
  sprintLengthWeeks: string;
  sizeMdMap: Record<Size, string>;
  holidayCalendarId: string;
  workStart: string;
  workEnd: string;
  timeLogEnabled: boolean;
};
function toForm(p: ProjectDetail): GeneralForm {
  const sizes = p.sizeMdMap ?? DEFAULT_SIZE_MD;
  return {
    name: p.name,
    key: p.key,
    startDate: p.startDate,
    goliveDate: p.goliveDate,
    visibility: p.visibility,
    estimateUnit: p.estimateUnit,
    sprintLengthWeeks: p.sprintLengthWeeks === null ? "" : String(p.sprintLengthWeeks),
    sizeMdMap: Object.fromEntries(SIZES.map((s) => [s, String(sizes[s])])) as Record<Size, string>,
    holidayCalendarId: p.holidayCalendarId ?? "",
    workStart: p.workStart ?? "",
    workEnd: p.workEnd ?? "",
    timeLogEnabled: p.timeLogEnabled,
  };
}
/** ส่งเฉพาะฟิลด์ที่เปลี่ยน (PATCH p/ ตอบ 400 ถ้าไม่มีอะไรเปลี่ยน) */
export function generalChanges(p: ProjectDetail, f: GeneralForm) {
  const before = toForm(p);
  const out: Record<string, unknown> = {};
  if (f.name.trim() !== before.name) out.name = f.name.trim();
  if (f.key.trim().toUpperCase() !== before.key) out.key = f.key.trim().toUpperCase();
  for (const k of ["startDate", "goliveDate", "visibility", "estimateUnit"] as const) if (f[k] !== before[k]) out[k] = f[k];
  if (f.sprintLengthWeeks !== before.sprintLengthWeeks) out.sprintLengthWeeks = f.sprintLengthWeeks ? Number(f.sprintLengthWeeks) : null;
  if (SIZES.some((s) => f.sizeMdMap[s] !== before.sizeMdMap[s])) out.sizeMdMap = Object.fromEntries(SIZES.map((s) => [s, Number(f.sizeMdMap[s])]));
  if (f.holidayCalendarId !== before.holidayCalendarId) out.holidayCalendarId = f.holidayCalendarId || null;
  if (f.workStart !== before.workStart) out.workStart = f.workStart || null;
  if (f.workEnd !== before.workEnd) out.workEnd = f.workEnd || null;
  if (f.timeLogEnabled !== before.timeLogEnabled) out.timeLogEnabled = f.timeLogEnabled;
  return out;
}

function GeneralSection({ ws, projectKey, project, members }: { ws: string; projectKey: string; project: ProjectDetail; members: Member[] }) {
  const t = useTranslations("project-settings-new.settings.general");
  const { workspace } = useWorkspace();
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => toForm(project));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ProjectDetail | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  // ปฏิทินวันหยุดอ่านได้เฉพาะ Admin ของ Workspace · คนอื่นเห็นค่าที่ตั้งไว้แต่เปลี่ยนไม่ได้
  const calendars = useQuery({
    queryKey: ["workspace", ws, "holiday-calendars"],
    queryFn: () => api.get<{ items: HolidayCalendar[] }>(`/w/${encodeURIComponent(ws)}/holiday-calendars`),
    enabled: isAdmin,
  });
  const owner = members.find((m) => m.userId === project.ownerUserId);
  const set = <K extends keyof GeneralForm>(k: K, v: GeneralForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const changes = generalChanges(project, form);
  const dirty = Object.keys(changes).length > 0;

  async function save() {
    setFieldError(null);
    if (!form.name.trim()) return setFieldError({ field: "name", message: t("required") });
    if (form.goliveDate < form.startDate) return setFieldError({ field: "goliveDate", message: t("goliveBeforeStart") });
    setSaving(true);
    try {
      const updated = await api.patch<ProjectDetail>(projectEndpoint(ws, projectKey), changes, project.version);
      for (const w of updated.warnings ?? []) toast({ message: w.message });
      toast({ message: t("saved") });
      await cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
      if (updated.key !== projectKey) {
        // Key ใหม่ = URL ใหม่ · Key เดิมยังเปิดได้ด้วย alias (301)
        router.replace(`/work/${encodeURIComponent(ws)}/p/${encodeURIComponent(updated.key)}/settings/general`);
        return;
      }
      cache.setQueryData(queryKeys.project(ws, projectKey), updated);
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") setConflict((e.latest as ProjectDetail | undefined) ?? project);
      else if (e instanceof ApiError && e.code === "key_taken") setFieldError({ field: "key", message: e.message });
      else if (e instanceof ApiError && Array.isArray(e.details.fields)) setFieldError({ field: String(e.details.fields[0]), message: e.message });
      else toast({ message: errorText(e, t("failed")) });
    } finally {
      setSaving(false);
    }
  }
  const err = (field: string) => (fieldError?.field === field ? fieldError.message : undefined);

  return (
    <>
      <SectionHead title={t("title")} description={t("description")} />
      <div className={styles.sb}>
        {conflict && (
          <ConflictState
            onLoadLatest={() => {
              cache.setQueryData(queryKeys.project(ws, projectKey), conflict);
              setConflict(null);
            }}
          />
        )}
        <div className={styles.grid}>
          <Input label={t("name")} value={form.name} onChange={(e) => set("name", e.target.value)} error={err("name")} maxLength={120} />
          <Input label={t("key")} value={form.key} onChange={(e) => set("key", e.target.value.toUpperCase())} error={err("key")} hint={t("keyHint")} maxLength={10} className={styles.mono} />
          <Input label={t("startDate")} type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} error={err("startDate")} />
          <Input label={t("goliveDate")} type="date" value={form.goliveDate} onChange={(e) => set("goliveDate", e.target.value)} error={err("goliveDate")} />
          <Select label={t("owner")} value={project.ownerUserId} disabled hint={t("ownerHint")} onChange={() => undefined}>
            <option value={project.ownerUserId}>{owner?.displayName ?? t("ownerUnknown")}</option>
          </Select>
          <Select label={t("visibility")} value={form.visibility} onChange={(e) => set("visibility", e.target.value as GeneralForm["visibility"])}>
            <option value="private">{t("visibilityPrivate")}</option>
            <option value="workspace">{t("visibilityWorkspace")}</option>
          </Select>
          <Select label={t("estimateUnit")} value={form.estimateUnit} hint={t("estimateHint")} onChange={(e) => set("estimateUnit", e.target.value as GeneralForm["estimateUnit"])}>
            <option value="man_day">{t("unitManDay")}</option>
            <option value="hour">{t("unitHour")}</option>
          </Select>
          <Select label={t("sprintLength")} value={form.sprintLengthWeeks} onChange={(e) => set("sprintLengthWeeks", e.target.value)}>
            <option value="1">{t("weeks", { n: 1 })}</option>
            <option value="2">{t("weeks", { n: 2 })}</option>
            <option value="3">{t("weeks", { n: 3 })}</option>
            <option value="">{t("noSprint")}</option>
          </Select>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("sizeMap")}</span>
          <div className={styles.sizes}>
            {SIZES.map((s) => (
              <label key={s}>
                <span className={styles.pill}>{s}</span>
                <input className={styles.in} type="number" min={0.25} step={0.25} value={form.sizeMdMap[s]} aria-label={t("sizeAria", { size: s })} onChange={(e) => set("sizeMdMap", { ...form.sizeMdMap, [s]: e.target.value })} />
              </label>
            ))}
          </div>
          <span className={styles.muted}>{project.sizeMdMap ? t("sizeHint") : t("sizeInherited")}</span>
          {err("sizeMdMap") && <span className="field-error" role="alert">{err("sizeMdMap")}</span>}
        </div>
        <div className={styles.grid}>
          <Select
            label={t("holidayCalendar")}
            value={form.holidayCalendarId}
            disabled={!calendars.data}
            hint={calendars.data ? t("holidayHint") : t("holidayAdminOnly")}
            error={err("holidayCalendarId")}
            onChange={(e) => set("holidayCalendarId", e.target.value)}
          >
            <option value="">{t("holidayWorkspace")}</option>
            {calendars.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {!calendars.data && form.holidayCalendarId && <option value={form.holidayCalendarId}>{t("holidayCustom")}</option>}
          </Select>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("workHours")}</span>
            <div className={styles.pills}>
              <input className={styles.in} type="time" value={form.workStart} aria-label={t("workStart")} onChange={(e) => set("workStart", e.target.value)} />
              <span aria-hidden="true">–</span>
              <input className={styles.in} type="time" value={form.workEnd} aria-label={t("workEnd")} onChange={(e) => set("workEnd", e.target.value)} />
            </div>
            <span className={err("workEnd") ? "field-error" : styles.muted}>{err("workEnd") ?? t("workHoursHint")}</span>
          </div>
        </div>
        <div className={styles.switchRow}>
          <button type="button" role="switch" className={styles.switch} aria-checked={form.timeLogEnabled} aria-label={t("timeLog")} onClick={() => set("timeLogEnabled", !form.timeLogEnabled)}>
            <span />
          </button>
          <div>
            <b>{t("timeLog")}</b> <span className={styles.pill}>{form.timeLogEnabled ? t("on") : t("offDefault")}</span>
            <div className={styles.muted}>{t("timeLogHint")}</div>
          </div>
        </div>
        <div className={styles.actions}>
          {dirty && <Button onClick={() => { setForm(toForm(project)); setFieldError(null); }}>{t("reset")}</Button>}
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? t("saving") : t("save")}</Button>
        </div>
      </div>
    </>
  );
}

function DangerSection({ ws, projectKey, project, access, members }: { ws: string; projectKey: string; project: ProjectDetail; access: Permissions; members: Member[] }) {
  const t = useTranslations("project-settings-new.settings.danger");
  const { me, workspace } = useWorkspace();
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const base = projectEndpoint(ws, projectKey);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const impact = useQuery({ queryKey: ["workspace", ws, "project", projectKey, "delete-impact"], queryFn: () => api.get<DeleteImpact>(`${base}/delete-impact`) });
  const archived = !!project.archivedAt;
  const canArchive = access.permissions.includes("project.archive");
  // โอนได้: Project Owner หรือ Workspace Owner / Admin (A04)
  const canTransfer = project.ownerUserId === me.id || workspace.role === "owner" || workspace.role === "admin";
  const candidates = members.filter((m) => m.userId !== project.ownerUserId && !m.isGuest && m.active);

  async function refresh() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.project(ws, projectKey) }),
      cache.invalidateQueries({ queryKey: queryKeys.permissions(ws, projectKey) }),
      cache.invalidateQueries({ queryKey: queryKeys.projects(ws) }),
      cache.invalidateQueries({ queryKey: membersKey(ws, projectKey) }),
    ]);
  }
  async function restore() {
    try {
      await api.post(`${base}/restore`);
      toast({ message: t("restored") });
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  async function transfer() {
    setBusy(true);
    try {
      await api.post(`${base}/transfer`, { userId: target });
      toast({ message: t("transferred", { name: candidates.find((m) => m.userId === target)?.displayName ?? "" }) });
      setTransferOpen(false);
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api.delete(base, { body: { confirmKey: confirm.trim() } });
      toast({ message: t("deleted", { key: project.key, days: impact.data?.trashDays ?? 30 }) });
      await cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
      router.push(`/work/${encodeURIComponent(ws)}`);
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHead title={t("title")} description={t("description")} />
      <div className={styles.sb}>
        {canArchive && (
          <div className={styles.dz}>
            <div>
              <b>{archived ? t("restoreTitle") : t("archiveTitle")}</b>
              <div className={styles.muted}>{archived ? t("restoreHint") : t("archiveHint")}</div>
            </div>
            {archived ? <Button onClick={() => void restore()}>{t("restore")}</Button> : <Button onClick={() => setArchiveOpen(true)}>{t("archive")}</Button>}
          </div>
        )}
        {canTransfer && (
          <div className={styles.dz}>
            <div>
              <b>{t("transferTitle")}</b>
              <div className={styles.muted}>{t("transferHint")}</div>
            </div>
            <Button onClick={() => { setTarget(candidates[0]?.userId ?? ""); setTransferOpen(true); }}>{t("transfer")}</Button>
          </div>
        )}
        {impact.error && <ErrorState error={impact.error} retry={() => void impact.refetch()} />}
        {impact.data && (
          <div className={`${styles.dz} ${styles.dzDelete}`}>
            <div>
              <b>{t("deleteTitle")}</b>
              <div className={styles.muted}>{t("deleteImpact", { issues: impact.data.issues, files: impact.data.files, members: impact.data.members, days: impact.data.trashDays })}</div>
            </div>
            {impact.data.canDelete ? (
              <>
                <Input label={t("confirmLabel", { key: project.key })} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={styles.mono} autoComplete="off" />
                <div>
                  <Button variant="danger" disabled={busy || confirm.trim().toUpperCase() !== project.key} onClick={() => void remove()}>{t("delete")}</Button>
                </div>
              </>
            ) : (
              <span className={styles.muted}>{t("deleteOwnerOnly")}</span>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={t("archiveConfirm", { name: project.name })}
        description={t("archiveHint")}
        confirmLabel={t("archive")}
        destructive={false}
        successMessage={t("archived")}
        onConfirm={async () => {
          await api.post(`${base}/archive`);
          await refresh();
        }}
      />
      <Dialog open={transferOpen} onOpenChange={setTransferOpen} title={t("transferTitle")} description={t("transferHint")}>
        <div className={styles.dialogForm}>
          {candidates.length ? (
            <Select label={t("transferTo")} value={target} onChange={(e) => setTarget(e.target.value)}>
              {candidates.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
          ) : (
            <p className={styles.muted}>{t("noCandidates")}</p>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setTransferOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={!target || busy} onClick={() => void transfer()}>{t("transferConfirm")}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
