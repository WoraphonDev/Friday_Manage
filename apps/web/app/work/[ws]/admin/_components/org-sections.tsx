"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { addDays, format, parseISO } from "date-fns";
import { Avatar, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api } from "@/lib/api";
import { formatDate, formatDateRange, today, localeNumberFormat } from "@/lib/format";
import { Card, patch, Switch, usePatchSettings, useSettings } from "./shared";
import {
  adminKey, errorText, SIZES, wsPath,
  type HolidayCalendar, type Holidays, type ProjectTemplate, type Size, type Team, type TeamDetail, type WorkspaceMember, type WorkspaceSettings, type WorkspaceWorkload,
} from "./types";
import styles from "./admin.module.css";
import { FALLBACK_PROJECT_COLOR } from "@/lib/colors";
import { TemplateFieldsDialog } from "./template-fields";

/** Template ในตัวที่คัดลอกมาเป็น Template ขององค์กรได้ (ตรงกับ API) · หมวดตามรายการที่ผู้ใช้ให้ 2026-11-09 */
const BUILTINS = ["development", "scrum", "kanban", "waterfall", "blank"] as const;
const CATEGORIES = ["software", "service", "work", "product", "marketing", "customer_service", "hr", "finance", "design", "personal", "operations", "legal", "sales", "analytics"] as const;

const TEAM_COLORS = ["#5B3FC4", "#1D4ED8", "#A21CAF", "#334155", "#0F766E", "#B45309", "#BE185D"];

function useMembers(ws: string) {
  return useQuery({ queryKey: ["workspace-members", ws], queryFn: () => api.get<{ items: WorkspaceMember[] }>(`${wsPath(ws)}/members`) });
}

// ---------------------------------------------------------------------------
// ทีม & โครงสร้าง
// ---------------------------------------------------------------------------

export function TeamsSection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.teams");
  const cache = useQueryClient();
  const key = adminKey(ws, "teams");
  const teams = useQuery({ queryKey: key, queryFn: () => api.get<{ items: Team[] }>(`${wsPath(ws)}/teams`) });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: key });

  return (
    <Card title={t("title")} actions={<Button variant="primary" onClick={() => setCreating(true)}>{t("create")}</Button>}>
      {teams.error ? (
        <ErrorState error={teams.error} retry={() => void teams.refetch()} />
      ) : !teams.data ? (
        <LoadingState />
      ) : teams.data.items.length === 0 ? (
        <EmptyState title={t("empty")} description={t("emptyHint")} />
      ) : (
        <div className={styles.teams}>
          {teams.data.items.map((team) => (
            <div key={team.id} className={styles.team}>
              <div className={styles.teamBar} style={{ background: team.color ?? FALLBACK_PROJECT_COLOR }} />
              <b>{team.name}</b>
              <span className={styles.muted}>{t("lead", { name: team.lead?.displayName ?? t("noLead") })}</span>
              <span className={styles.chips}>
                <span className={`${styles.pill} ${styles.neu}`}>{t("people", { n: team.memberCount })}</span>
                <span className={`${styles.pill} ${styles.neu}`}>{t("capacity", { n: team.capacityMdWeek })}</span>
              </span>
              <span className={styles.muted}>{t("projects", { n: team.projectCount })}</span>
              <div><Button size="small" onClick={() => setEditing(team.id)}>{t("edit")}</Button></div>
            </div>
          ))}
        </div>
      )}
      <span className={styles.muted}>{t("hint")}</span>
      <TeamDialog ws={ws} open={creating} onOpenChange={setCreating} onSaved={refresh} />
      {editing && <TeamEditor ws={ws} id={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </Card>
  );
}

function TeamDialog({ ws, open, onOpenChange, onSaved }: { ws: string; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const t = useTranslations("admin-automation.admin.teams");
  const toast = useToast();
  const members = useMembers(ws);
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const people = (members.data?.items ?? []).filter((m) => m.status === "active" && m.role !== "guest");
  async function save() {
    setBusy(true);
    try {
      const memberIds = [...new Set([...picked, ...(lead ? [lead] : [])])];
      await api.post(`${wsPath(ws)}/teams`, { name: name.trim(), color: TEAM_COLORS[name.length % TEAM_COLORS.length], leadUserId: lead || null, memberIds });
      toast({ message: t("created", { name: name.trim() }) });
      setName("");
      setLead("");
      setPicked([]);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("createTitle")}>
      <div className={styles.dialogForm}>
        <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Select label={t("leadLabel")} value={lead} onChange={(e) => setLead(e.target.value)}>
          <option value="">{t("noLead")}</option>
          {people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </Select>
        <fieldset className={styles.fld} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className={styles.lb}>{t("membersLabel")}</legend>
          <div className={styles.memberList}>
            {people.map((m) => (
              <label key={m.userId} className={styles.check}>
                <input type="checkbox" checked={picked.includes(m.userId)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.userId] : picked.filter((x) => x !== m.userId))} />
                {m.displayName}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="dialog-actions">
          <Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{t("save")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function TeamEditor({ ws, id, onClose, onSaved }: { ws: string; id: string; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("admin-automation.admin.teams");
  const toast = useToast();
  const cache = useQueryClient();
  const path = `${wsPath(ws)}/teams/${id}`;
  const detailKey = adminKey(ws, "team", id);
  const team = useQuery({ queryKey: detailKey, queryFn: () => api.get<TeamDetail>(path) });
  const members = useMembers(ws);
  const [name, setName] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const d = team.data;
  const inTeam = new Set(d?.members.map((m) => m.id));
  const candidates = (members.data?.items ?? []).filter((m) => m.status === "active" && m.role !== "guest" && !inTeam.has(m.userId));
  async function run(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      toast({ message });
      await cache.invalidateQueries({ queryKey: detailKey });
      onSaved();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const nameValue = name ?? d?.name ?? "";
  const leadValue = lead ?? d?.lead?.id ?? "";
  const dirty = !!d && (nameValue.trim() !== d.name || leadValue !== (d.lead?.id ?? ""));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={d ? t("editTitle", { name: d.name }) : t("edit")}>
      {team.error ? (
        <ErrorState error={team.error} retry={() => void team.refetch()} />
      ) : !d ? (
        <LoadingState />
      ) : (
        <div className={styles.dialogForm}>
          <Input label={t("name")} value={nameValue} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Select label={t("leadLabel")} value={leadValue} onChange={(e) => setLead(e.target.value)}>
            <option value="">{t("noLead")}</option>
            {d.members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </Select>
          <div className="dialog-actions">
            <Button variant="primary" disabled={!dirty || !nameValue.trim()} onClick={() => void run(() => patch(path, { name: nameValue.trim(), leadUserId: leadValue || null }), t("saved"))}>{t("save")}</Button>
          </div>
          <b>{t("membersLabel")}</b>
          <div className={styles.memberList}>
            {d.members.length === 0 && <span className={styles.muted}>{t("noMembers")}</span>}
            {d.members.map((m) => (
              <div key={m.id} className={styles.row}>
                <Avatar person={m} size="small" />
                <span className={styles.grow}>{m.displayName}<div className={styles.muted}>{m.jobTitle ?? ""}</div></span>
                <Button size="small" variant="ghost" aria-label={t("removeMember", { name: m.displayName })} onClick={() => void run(() => api.delete(`${path}/members/${m.id}`), t("memberRemoved", { name: m.displayName }))}>×</Button>
              </div>
            ))}
          </div>
          <div className={styles.chips}>
            <Select label={t("addMember")} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">{t("pick")}</option>
              {candidates.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
            <Button disabled={!adding} onClick={() => void run(() => api.post(`${path}/members`, { userIds: [adding] }), t("memberAdded")).then(() => setAdding(""))}>{t("add")}</Button>
          </div>
          <div className="dialog-actions">
            <Button variant="danger" onClick={() => setRemoveOpen(true)}>{t("delete")}</Button>
          </div>
          <ConfirmDialog
            open={removeOpen}
            onOpenChange={setRemoveOpen}
            title={t("deleteConfirm", { name: d.name })}
            description={t("deleteHint")}
            confirmLabel={t("delete")}
            successMessage={t("deleted", { name: d.name })}
            onConfirm={async () => {
              await api.delete(path);
              onSaved();
              onClose();
            }}
          />
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ค่ามาตรฐานขององค์กร
// ---------------------------------------------------------------------------

export function StandardsSection({ ws }: { ws: string }) {
  const settings = useSettings(ws);
  if (settings.error) return <ErrorState error={settings.error} retry={() => void settings.refetch()} />;
  if (!settings.data) return <LoadingState />;
  return (
    <>
      <CalendarCard ws={ws} settings={settings.data} />
      {/* โหลดค่าใหม่เมื่อค่าของฟอร์มนี้เปลี่ยน (สวิตช์ override บันทึกทันทีจึงไม่ล้างฟอร์ม) */}
      <WorkHoursCard key={JSON.stringify([settings.data.workStart, settings.data.workEnd, settings.data.workDays, settings.data.sizeMdMap])} ws={ws} settings={settings.data} />
      <TemplatesCard ws={ws} />
    </>
  );
}

function CalendarCard({ ws, settings }: { ws: string; settings: WorkspaceSettings }) {
  const t = useTranslations("admin-automation.admin.calendar");
  const { me } = useWorkspace();
  const cache = useQueryClient();
  const toast = useToast();
  const save = usePatchSettings(ws);
  const calKey = adminKey(ws, "calendars");
  const calendars = useQuery({ queryKey: calKey, queryFn: () => api.get<{ items: HolidayCalendar[] }>(`${wsPath(ws)}/holiday-calendars`) });
  const current = calendars.data?.items.find((c) => c.isDefault) ?? null;
  const from = today();
  const holidaysKey = adminKey(ws, "holidays", current?.id ?? "", from);
  const holidays = useQuery({
    queryKey: holidaysKey,
    queryFn: () => api.get<Holidays>(`${wsPath(ws)}/holidays?${new URLSearchParams({ calendarId: current!.id, from, to: format(addDays(parseISO(from), 120), "yyyy-MM-dd") })}`),
    enabled: !!current,
  });
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const system = calendars.data?.items.find((c) => !c.editable);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: calKey }), cache.invalidateQueries({ queryKey: adminKey(ws, "holidays") })]);

  async function importBank() {
    if (!system) return;
    try {
      // ปฏิทินของระบบแก้ไม่ได้ (A18) · คัดลอกเป็นของ Workspace แล้วตั้งเป็นค่าเริ่มต้น
      const created = await api.post<HolidayCalendar>(`${wsPath(ws)}/holiday-calendars`, { name: t("copyName", { name: system.name }), copyFromId: system.id });
      await save({ holidayCalendarId: created.id }, t("imported", { n: created.holidayCount }));
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  async function addHoliday() {
    try {
      const r = await api.post<{ recalculated: { issues: number; projects: number } }>(`${wsPath(ws)}/holidays`, { calendarId: current?.id, date, name: name.trim(), kind: "company" });
      toast({ message: r.recalculated.issues ? t("addedRecalc", { issues: r.recalculated.issues }) : t("added") });
      setAdding(false);
      setDate("");
      setName("");
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  async function removeHoliday(id: string) {
    try {
      await api.delete(`${wsPath(ws)}/holidays/${id}`);
      toast({ message: t("removed") });
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  const editable = !!current?.editable;
  return (
    <Card
      title={t("title")}
      actions={
        <>
          {system && <Button onClick={() => void importBank()}>{t("import")}</Button>}
          <Button variant="primary" disabled={!editable} title={editable ? undefined : t("readonly")} onClick={() => setAdding(true)}>{t("addCompany")}</Button>
        </>
      }
    >
      {calendars.error ? (
        <ErrorState error={calendars.error} retry={() => void calendars.refetch()} />
      ) : !calendars.data ? (
        <LoadingState />
      ) : (
        <>
          <Select
            label={t("default")}
            value={settings.holidayCalendarId ?? current?.id ?? ""}
            hint={t("defaultHint")}
            onChange={(e) => void save({ holidayCalendarId: e.target.value || null }).then(() => refresh())}
          >
            {!current && <option value="">{t("none")}</option>}
            {calendars.data.items.map((c) => <option key={c.id} value={c.id}>{c.name} · {t("count", { n: c.holidayCount })}{c.editable ? "" : ` · ${t("system")}`}</option>)}
          </Select>
          {!editable && current && <span className={styles.muted}>{t("readonly")}</span>}
          {holidays.error && <ErrorState error={holidays.error} retry={() => void holidays.refetch()} />}
          {holidays.data && (holidays.data.items.length === 0 ? (
            <span className={styles.muted}>{t("noUpcoming")}</span>
          ) : (
            <div>
              {holidays.data.items.map((h) => (
                <div key={h.id} className={styles.row}>
                  <span style={{ width: 130 }}>{formatDate(h.date, me.yearFormat, true)}</span>
                  <span className={styles.grow}>{h.name}</span>
                  <span className={`${styles.pill} ${h.kind === "company" ? styles.ent : styles.neu}`}>{t(h.kind === "company" ? "kindCompany" : "kindBank")}</span>
                  {editable && <Button size="small" variant="ghost" aria-label={t("remove", { name: h.name })} onClick={() => void removeHoliday(h.id)}>×</Button>}
                </div>
              ))}
            </div>
          ))}
          <span className={styles.muted}>{t("hint")}</span>
        </>
      )}
      <Dialog open={adding} onOpenChange={setAdding} title={t("addTitle")}>
        <div className={styles.dialogForm}>
          <Input label={t("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={!date || !name.trim()} onClick={() => void addHoliday()}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function WorkHoursCard({ ws, settings }: { ws: string; settings: WorkspaceSettings }) {
  const t = useTranslations("admin-automation.admin.std");
  const save = usePatchSettings(ws);
  const [workStart, setStart] = useState(settings.workStart);
  const [workEnd, setEnd] = useState(settings.workEnd);
  const [workDays, setDays] = useState(settings.workDays);
  const [sizes, setSizes] = useState<Record<Size, string>>(() => Object.fromEntries(SIZES.map((s) => [s, String(settings.sizeMdMap[s])])) as Record<Size, string>);
  const [busy, setBusy] = useState(false);
  const changes: Partial<WorkspaceSettings> = {};
  if (workStart !== settings.workStart) changes.workStart = workStart;
  if (workEnd !== settings.workEnd) changes.workEnd = workEnd;
  if ([...workDays].sort().join() !== [...settings.workDays].sort().join()) changes.workDays = [...workDays].sort();
  if (SIZES.some((s) => Number(sizes[s]) !== settings.sizeMdMap[s])) changes.sizeMdMap = Object.fromEntries(SIZES.map((s) => [s, Number(sizes[s])])) as Record<Size, number>;
  const dirty = Object.keys(changes).length > 0;
  const invalid = workEnd <= workStart || !workDays.length || SIZES.some((s) => !(Number(sizes[s]) > 0));
  async function submit() {
    setBusy(true);
    await save(changes);
    setBusy(false);
  }
  return (
    <Card title={t("title")}>
      <div className={styles.grid}>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("hours")}</span>
          <div className={styles.chips}>
            <input className={styles.in} style={{ width: 120 }} type="time" value={workStart} aria-label={t("start")} onChange={(e) => setStart(e.target.value)} />
            <span aria-hidden="true">–</span>
            <input className={styles.in} style={{ width: 120 }} type="time" value={workEnd} aria-label={t("end")} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <span className={workEnd <= workStart ? "field-error" : styles.muted}>{workEnd <= workStart ? t("endAfterStart") : t("hoursHint")}</span>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb} id="workdays-label">{t("days")}</span>
          <div className={styles.chips} role="group" aria-labelledby="workdays-label">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <button key={d} type="button" className={styles.chip} aria-pressed={workDays.includes(d)} onClick={() => setDays(workDays.includes(d) ? workDays.filter((x) => x !== d) : [...workDays, d])}>{t(`day${d}`)}</button>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.fld}>
        <span className={styles.lb}>{t("sizes")}</span>
        <div className={styles.chips}>
          {SIZES.map((s) => (
            <label key={s} className={styles.check}>
              <span className={`${styles.pill} ${styles.neu}`}>{s}</span>
              <input className={styles.in} style={{ width: 76 }} type="number" min={0.25} step={0.25} value={sizes[s]} aria-label={t("sizeAria", { size: s })} onChange={(e) => setSizes({ ...sizes, [s]: e.target.value })} />
            </label>
          ))}
        </div>
      </div>
      <div className={styles.switchRow}>
        <Switch checked={settings.allowProjectOverride} label={t("override")} onChange={(v) => void save({ allowProjectOverride: v })} />
        <div><b>{t("override")}</b><div className={styles.muted}>{t("overrideHint")}</div></div>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" disabled={!dirty || invalid || busy} onClick={() => void submit()}>{busy ? t("saving") : t("save")}</Button>
      </div>
    </Card>
  );
}

function TemplatesCard({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.templates");
  const cache = useQueryClient();
  const toast = useToast();
  const key = adminKey(ws, "templates");
  const templates = useQuery({ queryKey: key, queryFn: () => api.get<{ items: ProjectTemplate[] }>(`${wsPath(ws)}/project-templates`) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fromBuiltin, setFromBuiltin] = useState<string>("development");
  const [category, setCategory] = useState<string>("software");
  const [removing, setRemoving] = useState<ProjectTemplate | null>(null);
  const [editing, setEditing] = useState<ProjectTemplate | null>(null);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: ["workspace", ws, "template-catalog"] })]);
  async function create() {
    try {
      await api.post(`${wsPath(ws)}/project-templates`, { name: name.trim(), description: description.trim() || null, ...(fromBuiltin ? { fromBuiltin } : {}), config: { category } });
      toast({ message: t("created", { name: name.trim() }) });
      setOpen(false);
      setName("");
      setDescription("");
      await refresh();
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    }
  }
  async function saveConfig(tpl: ProjectTemplate, config: ProjectTemplate["config"]) {
    try {
      await api.request(`${wsPath(ws)}/project-templates/${tpl.id}`, { method: "PATCH", body: { config } });
      toast({ message: t("fieldsSaved", { name: tpl.name }) });
      await refresh();
      return true;
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
      return false;
    }
  }
  return (
    <Card title={t("title")} actions={<Button onClick={() => setOpen(true)}>{t("create")}</Button>}>
      {templates.error ? (
        <ErrorState error={templates.error} retry={() => void templates.refetch()} />
      ) : !templates.data ? (
        <LoadingState />
      ) : templates.data.items.length === 0 ? (
        <span className={styles.muted}>{t("empty")}</span>
      ) : (
        <div>
          {templates.data.items.map((tpl) => (
            <div key={tpl.id} className={styles.row}>
              <span className={styles.grow}><b>{tpl.name}</b><div className={styles.muted}>{tpl.description ?? ""}</div></span>
              <span className={`${styles.pill} ${styles.neu}`}>{t(`categories.${tpl.config?.category ?? "software"}`)}</span>
              <span className={`${styles.pill} ${styles.neu}`}>{t("used", { n: tpl.usageCount })}</span>
              <Button size="small" onClick={() => setEditing(tpl)}>{t("editFields")}</Button>
              <Button size="small" variant="ghost" aria-label={t("remove", { name: tpl.name })} onClick={() => setRemoving(tpl)}>×</Button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title={t("createTitle")} description={t("createHint")}>
        <div className={styles.dialogForm}>
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Input label={t("description")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          <Select label={t("startFrom")} value={fromBuiltin} onChange={(e) => setFromBuiltin(e.target.value)}>
            {BUILTINS.map((b) => <option key={b} value={b}>{t(`builtins.${b}`)}</option>)}
            <option value="">{t("startEmpty")}</option>
          </Select>
          <Select label={t("category")} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`categories.${c}`)}</option>)}
          </Select>
          <div className="dialog-actions">
            <Button onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>
      {editing && <TemplateFieldsDialog template={editing} onClose={() => setEditing(null)} onSave={(config) => saveConfig(editing, config)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={t("removeConfirm", { name: removing?.name ?? "" })}
        description={t("removeHint")}
        confirmLabel={t("delete")}
        successMessage={t("removed")}
        onConfirm={async () => {
          await api.delete(`${wsPath(ws)}/project-templates/${removing!.id}`);
          await cache.invalidateQueries({ queryKey: key });
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Workload รวม
// ---------------------------------------------------------------------------

/** 4 สัปดาห์นับจากวันจันทร์ของสัปดาห์นี้ (ตาม Canvas) */
export function workloadRange(now = today()) {
  const d = parseISO(now);
  const monday = addDays(d, -((d.getDay() + 6) % 7));
  return { from: format(monday, "yyyy-MM-dd"), to: format(addDays(monday, 27), "yyyy-MM-dd") };
}

export function WorkloadSection({ ws }: { ws: string }) {
  const t = useTranslations("admin-automation.admin.load");
  const { me } = useWorkspace();
  const [team, setTeam] = useState("");
  const [basis, setBasis] = useState<"plan" | "actual">("plan");
  const range = workloadRange();
  const params = new URLSearchParams({ ...range, group: "week", unit: "md" });
  // ตามแผนเป็นค่าเริ่มต้นของ API
  if (basis === "actual") params.set("basis", "actual");
  if (team) params.set("team", team);
  const teams = useQuery({ queryKey: adminKey(ws, "teams"), queryFn: () => api.get<{ items: Team[] }>(`${wsPath(ws)}/teams`) });
  const workload = useQuery({ queryKey: adminKey(ws, "workload", params.toString()), queryFn: () => api.get<WorkspaceWorkload>(`${wsPath(ws)}/workload?${params}`) });
  const num = localeNumberFormat({ maximumFractionDigits: 1 });
  const w = workload.data;
  return (
    <Card
      title={t("title")}
      actions={
        <>
          <Select aria-label={t("basisLabel")} value={basis} onChange={(e) => setBasis(e.target.value as "plan" | "actual")}>
            <option value="plan">{t("basis_plan")}</option>
            <option value="actual">{t("basis_actual")}</option>
          </Select>
          <Select aria-label={t("team")} value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">{t("allTeams")}</option>
            {teams.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </>
      }
    >
      {workload.error ? (
        <ErrorState error={workload.error} retry={() => void workload.refetch()} />
      ) : !w ? (
        <LoadingState />
      ) : w.people.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <div className={styles.wlScroll} style={{ margin: "-16px -18px" }}>
          <div className={`${styles.wl} ${styles.alHead}`} style={{ "--cols": w.buckets.length } as React.CSSProperties}>
            <div>{t("person")}</div>
            {w.buckets.map((b) => <div key={b.start}>{formatDateRange(b.start, b.end, me.yearFormat)}</div>)}
          </div>
          {w.people.map((p) => (
            <div key={p.person.id} className={styles.wl} style={{ "--cols": w.buckets.length } as React.CSSProperties}>
              <div className={styles.chips} style={{ flexWrap: "nowrap" }}>
                <Avatar person={p.person} size="small" />
                <span style={{ minWidth: 0 }}>
                  <b>{p.person.displayName}</b>
                  <div className={styles.muted}>{p.jobTitle ?? ""}</div>
                  <div className={styles.small} style={{ color: p.overPeriods ? "var(--danger-text)" : "var(--success-text)" }}>{p.overPeriods ? t("over", { n: p.overPeriods }) : t("within")}</div>
                  <div className={styles.small} style={{ color: p.overAllocated ? "var(--danger-text)" : undefined }}>{t("alloc", { a: p.allocatedHoursWeek, c: p.capacityHoursWeek })}</div>
                  {p.compare && (p.compare.plan > 0 || p.compare.actual > 0) && (
                    <div className={styles.small} title={t("compareHint")}>{t("compare", { actual: num.format(p.compare.actual), plan: num.format(p.compare.plan), pct: p.compare.actualVsPlanPct ?? "—" })}</div>
                  )}
                </span>
              </div>
              {p.cells.map((c, i) => (
                <div
                  key={w.buckets[i].start}
                  className={`${styles.wlCell} ${c.over ? styles.wlOver : ""}`}
                  title={c.byProject.map((x) => `${x.name} ${num.format(x.value)} MD`).join(" · ")}
                >
                  {num.format(c.value)}
                  <div className={styles.small}>{c.capacity === null ? "" : `/ ${num.format(c.capacity)}`}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <span className={styles.muted}>{t("hint")}</span>
    </Card>
  );
}
