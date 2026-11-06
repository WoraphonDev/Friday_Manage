"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Avatar, Badge, Button, Forbidden, Input, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateRange, today } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import {
  BUILTIN_TEMPLATES, firstMonday, KEY_PATTERN, lines, spanDays, sprintCount, suggestKey, TEMPLATE_PRESETS, validDate,
  type BuiltinTemplate, type WorkflowStep,
} from "./plan";
import styles from "./wizard.module.css";

const COLORS = ["#0F766E", "#1D4ED8", "#7C3AED", "#B45309", "#BE185D", "#334155"] as const;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const POSITIONS = ["Project Manager", "Lead / PM", "BA", "UX/UI Designer", "Frontend Dev", "Backend Dev", "Developer", "QA Engineer"];
const INTEGRATIONS = ["github", "gitlab", "line", "slack"] as const;
const PRIORITIES = [["urgent", "red"], ["high", "amber"], ["medium", "blue"], ["low", "neutral"]] as const;

interface WsMember {
  userId: string;
  displayName: string;
  email: string;
  role: "owner" | "admin" | "member" | "guest";
  status: string;
  jobTitle: string | null;
  capacityHoursWeek: number | null;
}
interface Template {
  id: string;
  name: string;
  description: string | null;
}
interface Calendar {
  id: string;
  name: string;
  isDefault: boolean;
}
interface TeamMember {
  userId: string;
  displayName: string;
  email: string;
  guest: boolean;
  role: "admin" | "member" | "viewer";
  position: string;
  capacityHoursWeek: number;
}
interface Draft {
  name: string;
  key: string;
  keyTouched: boolean;
  clientName: string;
  description: string;
  template: BuiltinTemplate | `ws:${string}`;
  color: string;
  startDate: string;
  goliveDate: string;
  timezone: string;
  holidayCalendarId: string;
  holidays: { date: string; name: string }[];
  sprintLengthWeeks: 1 | 2 | 3;
  milestones: { name: string; date: string }[];
  inScope: string[];
  outScope: string[];
  modules: string[];
  deliverables: string;
  acceptance: string;
  assumptions: string;
  visibility: "private" | "workspace";
  members: TeamMember[];
  workflow: WorkflowStep[];
  workflowTouched: boolean;
  estimateUnit: "man_day" | "hour";
  progressMethod: "count" | "weighted";
}
const initialDraft = (): Draft => ({
  name: "", key: "", keyTouched: false, clientName: "", description: "", template: "scrum", color: COLORS[0],
  startDate: today(), goliveDate: "", timezone: "Asia/Bangkok", holidayCalendarId: "", holidays: [], sprintLengthWeeks: 2,
  milestones: [], inScope: [], outScope: [], modules: [], deliverables: "", acceptance: "", assumptions: "",
  visibility: "private", members: [], workflow: TEMPLATE_PRESETS.scrum.workflow, workflowTouched: false,
  estimateUnit: "man_day", progressMethod: "count",
});
const draftKey = (ws: string) => `friday:new-project-draft:${ws}`;
type Errors = Partial<Record<"name" | "key" | "startDate" | "goliveDate" | "milestones" | "workflow", string>>;

/** body ของ POST w/projects (03-api › 3.4) · ขั้นที่ 3–5 ส่งเฉพาะที่กรอก */
export function buildBody(d: Draft) {
  const builtin = !d.template.startsWith("ws:");
  const preset = builtin ? TEMPLATE_PRESETS[d.template as BuiltinTemplate] : null;
  const scope = {
    in: d.inScope,
    out: d.outScope,
    deliverables: lines(d.deliverables),
    acceptance: lines(d.acceptance),
    assumptions: lines(d.assumptions),
  };
  const filledScope = Object.fromEntries(Object.entries(scope).filter(([, v]) => v.length));
  return {
    name: d.name.trim(),
    key: d.key.trim().toUpperCase(),
    ...(d.clientName.trim() ? { clientName: d.clientName.trim() } : {}),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(builtin ? {} : { templateId: d.template.slice(3) }),
    color: d.color,
    startDate: d.startDate,
    goliveDate: d.goliveDate,
    timezone: d.timezone,
    visibility: d.visibility,
    ...(d.holidayCalendarId ? { holidayCalendarId: d.holidayCalendarId } : {}),
    ...(d.holidays.length ? { extraHolidays: d.holidays } : {}),
    // Template ของ Workspace กำหนดความยาว Sprint เอง · Template ในตัวส่งค่าตรง ๆ
    ...(preset ? { sprintLengthWeeks: preset.sprint ? d.sprintLengthWeeks : null } : {}),
    modules: d.modules,
    milestones: d.milestones.filter((m) => m.name.trim() && m.date).map((m) => ({ name: m.name.trim(), date: m.date })),
    ...(Object.keys(filledScope).length ? { scope: filledScope } : {}),
    ...(d.members.length
      ? { members: d.members.map((m) => ({ userId: m.userId, role: m.role, ...(m.position ? { position: m.position } : {}), capacityHoursWeek: m.capacityHoursWeek })) }
      : {}),
    ...(builtin || d.workflowTouched
      ? { workflow: d.workflow.map((s) => (s.wipLimit ? { name: s.name, wipLimit: s.wipLimit } : s.name)) }
      : {}),
    estimateUnit: d.estimateUnit,
    progressMethod: d.progressMethod,
  };
}

export function NewProjectWizard({ ws }: { ws: string }) {
  const t = useTranslations("project-settings-new.wizard");
  const { me, workspace } = useWorkspace();
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  const wsPath = `/w/${encodeURIComponent(ws)}`;
  const [step, setStep] = useState(1);
  const [d, setDraft] = useState<Draft>(initialDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [creating, setCreating] = useState(false);
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((x) => ({ ...x, [k]: v }));

  // Template / ปฏิทินวันหยุดของ Workspace อ่านได้เฉพาะ Admin · Member ได้ 403 จึงไม่เรียกและใช้ Template ในตัวแทน
  const templates = useQuery({
    queryKey: ["workspace", ws, "project-templates"],
    queryFn: () => api.get<{ items: Template[] }>(`${wsPath}/project-templates`),
    enabled: isAdmin,
    retry: false,
  });
  const calendars = useQuery({
    queryKey: ["workspace", ws, "holiday-calendars"],
    queryFn: () => api.get<{ items: Calendar[] }>(`${wsPath}/holiday-calendars`),
    enabled: isAdmin,
    retry: false,
  });
  const directory = useQuery({
    queryKey: ["workspace", ws, "members"],
    queryFn: () => api.get<{ items: WsMember[] }>(`${wsPath}/members`),
    enabled: step === 4 && workspace.role !== "guest",
  });

  useEffect(() => {
    // ร่างอยู่ในเครื่องนี้เท่านั้น (API ยังไม่มีร่างโปรเจกต์)
    try {
      const saved = window.localStorage.getItem(draftKey(ws));
      if (saved) setDraft({ ...initialDraft(), ...(JSON.parse(saved) as Partial<Draft>) });
    } catch {
      /* ร่างเสีย = เริ่มใหม่ */
    }
  }, [ws]);

  if (workspace.role === "guest") return <Forbidden />;

  const span = spanDays(d.startDate, d.goliveDate);
  const preset = d.template.startsWith("ws:") ? null : TEMPLATE_PRESETS[d.template as BuiltinTemplate];
  const isScrum = !!preset?.sprint;
  const sprints = isScrum ? sprintCount(d.startDate, d.goliveDate, d.sprintLengthWeeks) : 0;
  const templateName = preset ? t(`templates.${d.template}.name`) : (templates.data?.items.find((x) => `ws:${x.id}` === d.template)?.name ?? t("templates.workspace"));
  const capacity = d.members.reduce((sum, m) => sum + (m.capacityHoursWeek || 0), 0);
  const steps = [1, 2, 3, 4, 5] as const;

  function validate(upTo: number) {
    const e: Errors = {};
    if (upTo >= 1) {
      if (!d.name.trim()) e.name = t("errors.required");
      if (!KEY_PATTERN.test(d.key.trim().toUpperCase())) e.key = t("errors.key");
    }
    if (upTo >= 2) {
      if (!validDate(d.startDate)) e.startDate = t("errors.required");
      if (!validDate(d.goliveDate)) e.goliveDate = t("errors.required");
      else if (d.goliveDate < d.startDate) e.goliveDate = t("errors.goliveBeforeStart");
      if (d.milestones.some((m) => !m.name.trim() || !validDate(m.date))) e.milestones = t("errors.milestone");
    }
    if (upTo >= 5 && d.workflow.length < 2) e.workflow = t("errors.workflow");
    setErrors(e);
    if (e.name || e.key) setStep(1);
    else if (e.startDate || e.goliveDate || e.milestones) setStep(2);
    return Object.keys(e).length === 0;
  }
  async function checkKey() {
    const key = d.key.trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) return KEY_PATTERN.test(key);
    try {
      const r = await api.get<{ available: boolean }>(`${wsPath}/projects/key-available?key=${encodeURIComponent(key)}`);
      if (!r.available) setErrors((x) => ({ ...x, key: t("errors.keyTaken", { key }) }));
      return r.available;
    } catch {
      return true; // ตรวจไม่ได้ให้ API ตอบ 409 ตอนสร้างแทน
    }
  }
  async function go(target: number) {
    if (target <= step) return setStep(target);
    // ขั้น 1–2 บังคับ · ข้ามไปขั้นหลังได้เมื่อกรอกขั้นบังคับครบ
    if (!validate(Math.min(target - 1, 2))) return;
    if (step === 1 && !(await checkKey())) return;
    setStep(target);
  }
  function pickTemplate(template: Draft["template"]) {
    setDraft((x) => {
      const p = template.startsWith("ws:") ? null : TEMPLATE_PRESETS[template as BuiltinTemplate];
      return {
        ...x,
        template,
        workflow: p && !x.workflowTouched ? p.workflow : x.workflow,
        modules: p?.modules && !x.modules.length ? p.modules : x.modules,
      };
    });
  }
  function saveDraft() {
    try {
      window.localStorage.setItem(draftKey(ws), JSON.stringify(d));
      toast({ message: t("draftSaved") });
    } catch {
      toast({ message: t("draftFailed") });
    }
  }
  async function create() {
    if (!validate(step === 5 ? 5 : 2)) return;
    setCreating(true);
    try {
      const project = await api.post<{ key: string; created: { modules: number; statuses: number; milestones: number; sprints: number; members: number } }>(`${wsPath}/projects`, buildBody(d));
      try {
        window.localStorage.removeItem(draftKey(ws));
      } catch {
        /* ไม่มี storage ก็ไม่เป็นไร */
      }
      toast({ message: t("created", { key: project.key, modules: project.created.modules, statuses: project.created.statuses, sprints: project.created.sprints }) });
      await cache.invalidateQueries({ queryKey: queryKeys.projects(ws) });
      router.push(`${wsPath}/p/${encodeURIComponent(project.key)}`);
    } catch (e) {
      setCreating(false);
      const message = e instanceof ApiError && e.requestId ? `${e.message} (${e.requestId})` : e instanceof Error ? e.message : t("errors.failed");
      if (e instanceof ApiError && e.code === "key_taken") {
        setErrors({ key: e.message });
        setStep(1);
        return;
      }
      const fields = e instanceof ApiError && Array.isArray(e.details.fields) ? (e.details.fields as unknown[]).map(String) : [];
      if (fields.includes("goliveDate")) {
        setErrors({ goliveDate: e instanceof Error ? e.message : "" });
        setStep(2);
      } else if (fields.includes("workflow")) {
        setErrors({ workflow: e instanceof Error ? e.message : "" });
        setStep(5);
      }
      toast({ message });
    }
  }

  const stepBody: Record<number, ReactNode> = {
    1: (
      <>
        <div className={styles.grid}>
          <Input
            label={`${t("name")} *`}
            value={d.name}
            placeholder={t("namePlaceholder")}
            maxLength={120}
            error={errors.name}
            onChange={(e) => {
              const name = e.target.value;
              setDraft((x) => ({ ...x, name, key: x.keyTouched ? x.key : suggestKey(name) }));
            }}
          />
          <Input
            label={`${t("key")} *`}
            value={d.key}
            maxLength={10}
            className={styles.mono}
            error={errors.key}
            hint={t("keyHint", { key: d.key || "DP" })}
            onChange={(e) => setDraft((x) => ({ ...x, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""), keyTouched: true }))}
            onBlur={() => void checkKey()}
          />
          <Input label={t("client")} value={d.clientName} placeholder={t("clientPlaceholder")} hint={t("clientHint")} maxLength={120} onChange={(e) => set("clientName", e.target.value)} />
          <label className={styles.fld}>
            <span className={styles.lb}>{t("description")}</span>
            <textarea className={styles.in} rows={3} value={d.description} placeholder={t("descriptionPlaceholder")} onChange={(e) => set("description", e.target.value)} />
          </label>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("template")} *</span>
          <div className={styles.opts} role="group" aria-label={t("template")}>
            {BUILTIN_TEMPLATES.map((x) => (
              <button key={x} type="button" className={styles.opt} aria-pressed={d.template === x} onClick={() => pickTemplate(x)}>
                <b>{t(`templates.${x}.name`)}</b>
                <span className={styles.muted}>{t(`templates.${x}.description`)}</span>
                <span className={styles.makes}>{t(`templates.${x}.makes`)}</span>
              </button>
            ))}
            {templates.data?.items.map((x) => (
              <button key={x.id} type="button" className={styles.opt} aria-pressed={d.template === `ws:${x.id}`} onClick={() => pickTemplate(`ws:${x.id}`)}>
                <b>{x.name}</b>
                <span className={styles.muted}>{x.description ?? t("templates.workspace")}</span>
                <span className={styles.makes}>{t("templates.workspaceMakes")}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.inline}>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("color")}</span>
            <div className={styles.swatches}>
              {COLORS.map((c) => (
                <button key={c} type="button" className={styles.sw} style={{ background: c }} aria-label={t("colorOf", { name: t(`colors.${c.slice(1)}`) })} aria-pressed={d.color === c} onClick={() => set("color", c)} />
              ))}
            </div>
          </div>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("icon")}</span>
            <span className={styles.badge} style={{ background: d.color }}>{d.key || "—"}</span>
          </div>
        </div>
      </>
    ),
    2: (
      <>
        <div className={styles.grid}>
          <Input label={`${t("startDate")} *`} type="date" value={d.startDate} error={errors.startDate} onChange={(e) => set("startDate", e.target.value)} />
          <Input label={`${t("goliveDate")} *`} type="date" value={d.goliveDate} error={errors.goliveDate} onChange={(e) => set("goliveDate", e.target.value)} />
          <Select label={t("timezone")} value={d.timezone} onChange={(e) => set("timezone", e.target.value)}>
            <option value="Asia/Bangkok">Asia/Bangkok (GMT+7)</option>
            <option value="Asia/Singapore">Asia/Singapore (GMT+8)</option>
            <option value="UTC">UTC</option>
          </Select>
        </div>
        {span && <div className={styles.note} role="status">{t("span", { days: span.calendar, working: span.working })}</div>}
        <div className={styles.fld}>
          <span className={styles.lb}>{t("workDays")}</span>
          <div className={styles.swatches}>
            {DAYS.map((x, i) => <button key={x} type="button" className={styles.tg} aria-pressed={i < 5} disabled>{t(`days.${x}`)}</button>)}
          </div>
          <span className={styles.hint}>{t("workDaysHint")}</span>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("holidays")}</span>
          {calendars.data ? (
            <Select label={t("holidayCalendar")} value={d.holidayCalendarId} onChange={(e) => set("holidayCalendarId", e.target.value)}>
              <option value="">{t("holidayDefault")}</option>
              {calendars.data.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          ) : (
            <span className={styles.hint}>{t("holidayDefaultHint")}</span>
          )}
          <div className={styles.chips}>
            {d.holidays.map((h, i) => (
              <span key={`${h.date}${i}`} className={styles.chipx}>
                {formatDate(h.date, me.yearFormat)} · {h.name}
                <button type="button" className={styles.x} aria-label={t("removeHoliday", { name: h.name })} onClick={() => set("holidays", d.holidays.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
          <HolidayAdder onAdd={(h) => set("holidays", [...d.holidays, h])} />
        </div>
        {isScrum && (
          <div className={styles.fld}>
            <span className={styles.lb}>{t("sprintLength")}</span>
            <div className={styles.swatches}>
              {([1, 2, 3] as const).map((w) => (
                <button key={w} type="button" className={styles.tg} aria-pressed={d.sprintLengthWeeks === w} onClick={() => set("sprintLengthWeeks", w)}>{t("weeks", { n: w })}</button>
              ))}
              {firstMonday(d.startDate) && sprints > 0 && <span className={styles.hint}>{t("sprintHint", { date: formatDate(firstMonday(d.startDate), me.yearFormat), count: sprints })}</span>}
            </div>
          </div>
        )}
        <div className={styles.fld}>
          <span className={styles.lb}>{t("milestones")}</span>
          {d.milestones.map((m, i) => (
            <div key={i} className={styles.milestone}>
              <span className={styles.diamond} aria-hidden="true" />
              <input className={styles.in} value={m.name} aria-label={t("milestoneName", { n: i + 1 })} onChange={(e) => set("milestones", d.milestones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input className={styles.in} type="date" value={m.date} aria-label={t("milestoneDate", { n: i + 1 })} onChange={(e) => set("milestones", d.milestones.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
              <button type="button" className={styles.x} aria-label={t("removeMilestone", { n: i + 1 })} onClick={() => set("milestones", d.milestones.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          {errors.milestones && <span className="field-error" role="alert">{errors.milestones}</span>}
          <div>
            <Button onClick={() => set("milestones", [...d.milestones, { name: "", date: d.goliveDate || d.startDate }])}>{t("addMilestone")}</Button>
          </div>
        </div>
      </>
    ),
    3: (
      <>
        <div className={styles.grid}>
          <ChipList label={t("inScope")} items={d.inScope} onChange={(v) => set("inScope", v)} placeholder={t("enterToAdd")} removeLabel={(x) => t("removeItem", { name: x })} />
          <ChipList label={t("outScope")} items={d.outScope} onChange={(v) => set("outScope", v)} placeholder={t("enterToAdd")} removeLabel={(x) => t("removeItem", { name: x })} hint={t("outScopeHint")} />
        </div>
        <ChipList label={t("modules")} items={d.modules} onChange={(v) => set("modules", v)} placeholder={t("moduleToAdd")} removeLabel={(x) => t("removeModule", { name: x })} hint={t("modulesHint")} />
        <div className={styles.grid}>
          <label className={styles.fld}>
            <span className={styles.lb}>{t("deliverables")}</span>
            <textarea className={styles.in} rows={3} value={d.deliverables} placeholder={t("onePerLine")} onChange={(e) => set("deliverables", e.target.value)} />
          </label>
          <label className={styles.fld}>
            <span className={styles.lb}>{t("acceptance")}</span>
            <textarea className={styles.in} rows={3} value={d.acceptance} placeholder={t("onePerLine")} onChange={(e) => set("acceptance", e.target.value)} />
          </label>
          <label className={styles.fld}>
            <span className={styles.lb}>{t("assumptions")}</span>
            <textarea className={styles.in} rows={3} value={d.assumptions} placeholder={t("assumptionsPlaceholder")} onChange={(e) => set("assumptions", e.target.value)} />
          </label>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("files")}</span>
          <div className={styles.drop} aria-disabled="true">
            <span>{t("filesClosed")}</span>
          </div>
        </div>
      </>
    ),
    4: (
      <>
        <div className={styles.grid}>
          <Select label={`${t("owner")} *`} value={me.id} disabled hint={t("ownerHint")} onChange={() => undefined}>
            <option value={me.id}>{t("you", { name: me.displayName })}</option>
          </Select>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("visibility")}</span>
            <div className={styles.opts2} role="group" aria-label={t("visibility")}>
              {(["private", "workspace"] as const).map((v) => (
                <button key={v} type="button" className={styles.opt} aria-pressed={d.visibility === v} onClick={() => set("visibility", v)}>
                  <b>{t(`visibilityOptions.${v}.name`)}</b>
                  <span className={styles.muted}>{t(`visibilityOptions.${v}.description`)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <TeamPicker
          me={{ id: me.id, displayName: me.displayName, email: me.email }}
          directory={directory.data?.items ?? []}
          loading={directory.isLoading}
          error={directory.error}
          members={d.members}
          onChange={(v) => set("members", v)}
        />
      </>
    ),
    5: (
      <>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("workflow")}</span>
          <WorkflowEditor
            steps={d.workflow}
            onChange={(workflow) => setDraft((x) => ({ ...x, workflow, workflowTouched: true }))}
          />
          {errors.workflow ? <span className="field-error" role="alert">{errors.workflow}</span> : <span className={styles.hint}>{t("workflowHint")}</span>}
        </div>
        <div className={styles.grid}>
          <fieldset className={styles.fieldset}>
            <legend className={styles.lb}>{t("estimateUnit")}</legend>
            <label className={styles.radio}><input type="radio" name="est" checked={d.estimateUnit === "man_day"} onChange={() => set("estimateUnit", "man_day")} />{t("unitManDay")}</label>
            <label className={styles.radio}><input type="radio" name="est" checked={d.estimateUnit === "hour"} onChange={() => set("estimateUnit", "hour")} />{t("unitHour")}</label>
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.lb}>{t("progressMethod")}</legend>
            <label className={styles.radio}><input type="radio" name="pg" checked={d.progressMethod === "count"} onChange={() => set("progressMethod", "count")} />{t("progressCount")}</label>
            <label className={styles.radio}><input type="radio" name="pg" checked={d.progressMethod === "weighted"} onChange={() => set("progressMethod", "weighted")} />{t("progressWeighted")}</label>
          </fieldset>
          <div className={styles.fld}>
            <span className={styles.lb}>{t("priorities")}</span>
            <div className={styles.chips}>{PRIORITIES.map(([p, tone]) => <Badge key={p} tone={tone}>{t(`priority.${p}`)}</Badge>)}</div>
          </div>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("integrations")}</span>
          <div className={styles.integ}>
            {INTEGRATIONS.map((g) => (
              <div key={g} className={styles.integItem}>
                <span className={styles.ab}>{t(`integration.${g}.ab`)}</span>
                <div>
                  <div>{t(`integration.${g}.name`)}</div>
                  <div className={styles.muted}>{t(`integration.${g}.description`)}</div>
                </div>
                <Button size="small" disabled title={t("notYet")}>{t("connect")}</Button>
              </div>
            ))}
          </div>
          <span className={styles.hint}>{t("integrationsHint")}</span>
        </div>
        <label className={styles.radio}>
          <input type="checkbox" disabled />
          {t("budget")}
        </label>
      </>
    ),
  };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <div className={styles.muted}>{t("breadcrumb", { workspace: workspace.name })}</div>
          <h1>{t("title")}</h1>
        </div>
        <div className={styles.actions}>
          <Button onClick={saveDraft}>{t("saveDraft")}</Button>
          <Link className="button button-secondary" href={wsPath}>{t("cancel")}</Link>
        </div>
      </header>
      <div className={styles.body}>
        <nav className={`${styles.card} ${styles.steps}`} aria-label={t("stepsLabel")}>
          {steps.map((n) => (
            <button key={n} type="button" className={styles.st} aria-current={n === step ? "step" : undefined} onClick={() => void go(n)}>
              <span className={`${styles.sn} ${n < step ? styles.done : n === step ? styles.on : ""}`}>{n < step ? "✓" : n}</span>
              <span className={styles.stText}>
                <span>{t(`steps.${n}.title`)}</span>
                <span className={styles.muted}>{t(`steps.${n}.short`)}</span>
              </span>
            </button>
          ))}
          <div className={styles.hint}>{t("stepsHint")}</div>
        </nav>

        <section className={`${styles.card} ${styles.form}`} aria-labelledby="wizard-step">
          <div className={styles.formHead}>
            <div className={styles.muted}>{t("stepOf", { n: step })}</div>
            <h2 id="wizard-step">{t(`steps.${step}.title`)}</h2>
            <div className={styles.muted}>{t(`steps.${step}.description`)}</div>
          </div>
          <div className={styles.formBody}>{stepBody[step]}</div>
          <div className={styles.footer}>
            {step > 1 && <Button onClick={() => setStep(step - 1)}>{t("back")}</Button>}
            <span className={styles.spacer} />
            {step >= 2 && step < 5 && <Button disabled={creating} onClick={() => void create()}>{t("createNow")}</Button>}
            {step < 5 && <Button variant="primary" onClick={() => void go(step + 1)}>{t("next")}</Button>}
            {step === 5 && <Button variant="primary" disabled={creating} onClick={() => void create()}>{creating ? t("creating") : t("create")}</Button>}
          </div>
        </section>

        <aside className={`${styles.card} ${styles.summary}`} aria-label={t("summaryLabel")}>
          <div className={styles.muted}>{t("summaryTitle")}</div>
          <div className={styles.inline}>
            <span className={styles.badge} style={{ background: d.color }}>{d.key || "—"}</span>
            <div>
              <div><b>{d.name || t("untitled")}</b></div>
              <div className={styles.muted}>{d.key ? t("firstIssue", { key: d.key }) : t("noKey")}</div>
            </div>
          </div>
          <div>
            <SummaryRow label={t("summary.template")} value={templateName} />
            <SummaryRow label={t("summary.period")} value={d.goliveDate ? formatDateRange(d.startDate, d.goliveDate, me.yearFormat) : "—"} />
            <SummaryRow label={t("summary.workingDays")} value={span ? t("summary.days", { n: span.working }) : "—"} />
            <SummaryRow label={t("summary.pm")} value={me.displayName} />
            <SummaryRow label={t("summary.members")} value={t("summary.membersValue", { count: d.members.length + 1, hours: capacity })} />
            <SummaryRow label={t("summary.visibility")} value={t(`visibilityOptions.${d.visibility}.name`)} />
          </div>
          <div>
            <b>{t("autoTitle")}</b>
            <ul className={styles.auto}>
              {d.modules.length > 0 && <li>{t("auto.modules", { count: d.modules.length })}</li>}
              <li>{t("auto.statuses", { count: d.workflow.length, first: d.workflow[0]?.name ?? "", last: d.workflow.at(-1)?.name ?? "" })}</li>
              {d.milestones.length > 0 && <li>{t("auto.milestones", { count: d.milestones.length })}</li>}
              {sprints > 0 && <li>{t("auto.sprints", { count: sprints, weeks: d.sprintLengthWeeks })}</li>}
              {d.holidays.length > 0 && <li>{t("auto.holidays", { count: d.holidays.length })}</li>}
              {d.members.length > 0 && <li>{t("auto.members", { count: d.members.length })}</li>}
            </ul>
          </div>
          <div className={styles.muted}>{t("initialStatus")}</div>
        </aside>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.sumr}>
      <span className={styles.muted}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ChipList({ label, items, onChange, placeholder, removeLabel, hint }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; removeLabel: (x: string) => string; hint?: string }) {
  const [value, setValue] = useState("");
  return (
    <div className={styles.fld}>
      <span className={styles.lb}>{label}</span>
      <div className={styles.chips}>
        {items.map((x, i) => (
          <span key={`${x}${i}`} className={styles.chipx}>
            {x}
            <button type="button" className={styles.x} aria-label={removeLabel(x)} onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
      </div>
      <input
        className={styles.in}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          const v = value.trim();
          if (v && !items.includes(v)) onChange([...items, v]);
          setValue("");
        }}
      />
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

function HolidayAdder({ onAdd }: { onAdd: (h: { date: string; name: string }) => void }) {
  const t = useTranslations("project-settings-new.wizard");
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  return (
    <div className={styles.adder}>
      <input className={styles.in} type="date" value={date} aria-label={t("holidayDate")} onChange={(e) => setDate(e.target.value)} />
      <input className={styles.in} value={name} placeholder={t("holidayName")} aria-label={t("holidayName")} onChange={(e) => setName(e.target.value)} />
      <Button disabled={!validDate(date) || !name.trim()} onClick={() => { onAdd({ date, name: name.trim() }); setDate(""); setName(""); }}>{t("addHoliday")}</Button>
    </div>
  );
}

function WorkflowEditor({ steps, onChange }: { steps: WorkflowStep[]; onChange: (v: WorkflowStep[]) => void }) {
  const t = useTranslations("project-settings-new.wizard");
  const [value, setValue] = useState("");
  const add = () => {
    const v = value.trim();
    if (!v || steps.some((s) => s.name.toLowerCase() === v.toLowerCase())) return;
    // สถานะใหม่แทรกก่อนสถานะสุดท้าย (Done) เพราะ API เดาหมวดจากตำแหน่ง: แรก = To do, สุดท้าย = Done
    onChange([...steps.slice(0, -1), { name: v }, ...steps.slice(-1)]);
    setValue("");
  };
  return (
    <div className={styles.chips}>
      {steps.map((s, i) => (
        <span key={s.name} className={styles.chips}>
          {i > 0 && <span className={styles.muted} aria-hidden="true">→</span>}
          <span className={styles.chipx}>
            <span className={styles.dot} />
            {s.name}
            {s.wipLimit ? <span className={styles.muted}>WIP {s.wipLimit}</span> : null}
            {steps.length > 2 && <button type="button" className={styles.x} aria-label={t("removeStatus", { name: s.name })} onClick={() => onChange(steps.filter((_, j) => j !== i))}>×</button>}
          </span>
        </span>
      ))}
      <input className={styles.in} value={value} placeholder={t("statusToAdd")} aria-label={t("statusToAdd")} maxLength={60} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
      <Button onClick={add} disabled={!value.trim()}>{t("addStatus")}</Button>
    </div>
  );
}

function TeamPicker({ me, directory, loading, error, members, onChange }: {
  me: { id: string; displayName: string; email: string };
  directory: WsMember[];
  loading: boolean;
  error: unknown;
  members: TeamMember[];
  onChange: (v: TeamMember[]) => void;
}) {
  const t = useTranslations("project-settings-new.wizard");
  const toast = useToast();
  const [query, setQuery] = useState("");
  const candidates = directory.filter((m) => m.status === "active" && m.userId !== me.id && !members.some((x) => x.userId === m.userId));

  function add() {
    const tokens = query.split(",").map((x) => x.trim()).filter(Boolean);
    const found: TeamMember[] = [];
    const missing: string[] = [];
    for (const token of tokens) {
      const q = token.toLowerCase();
      const hit = candidates.find((m) => m.email.toLowerCase() === q || m.displayName.toLowerCase() === q) ?? candidates.find((m) => m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
      if (hit && !found.some((f) => f.userId === hit.userId)) {
        found.push({ userId: hit.userId, displayName: hit.displayName, email: hit.email, guest: hit.role === "guest", role: "member", position: hit.jobTitle ?? "", capacityHoursWeek: hit.capacityHoursWeek ?? 40 });
      } else if (!hit) missing.push(token);
    }
    if (found.length) onChange([...members, ...found]);
    // คนนอก Workspace ยังเชิญจากที่นี่ไม่ได้ (API ยังไม่รับ invites)
    if (missing.length) toast({ message: t("notInWorkspace", { names: missing.join(", ") }) });
    setQuery("");
  }
  const update = (userId: string, patch: Partial<TeamMember>) => onChange(members.map((m) => (m.userId === userId ? { ...m, ...patch } : m)));

  return (
    <div className={styles.fld}>
      <span className={styles.lb}>{t("members")}</span>
      <div className={styles.inline}>
        <input
          className={styles.in}
          style={{ flex: 1 }}
          list="wizard-directory"
          value={query}
          placeholder={t("membersPlaceholder")}
          aria-label={t("membersPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }}
        />
        <datalist id="wizard-directory">
          {candidates.map((m) => <option key={m.userId} value={m.email}>{m.displayName}</option>)}
        </datalist>
        <Button variant="primary" disabled={!query.trim() || loading} onClick={add}>{t("addMember")}</Button>
      </div>
      {error ? <span className="field-error" role="alert">{error instanceof Error ? error.message : t("errors.failed")}</span> : null}
      <div className={`${styles.row} ${styles.rowHead}`} aria-hidden="true">
        <span>{t("memberCol")}</span><span>{t("positionCol")}</span><span>{t("roleCol")}</span><span>{t("capacityCol")}</span><span />
      </div>
      <div className={styles.row}>
        <div className={styles.inline}><Avatar person={{ id: me.id, displayName: me.displayName }} /><div><div>{me.displayName}</div><div className={styles.muted}>{t("ownerTag", { email: me.email })}</div></div></div>
        <span className={styles.muted}>—</span>
        <span>{t("roles.admin")}</span>
        <span className={styles.muted}>—</span>
        <span />
      </div>
      {members.map((m) => (
        <div key={m.userId} className={styles.row} data-testid={`member-${m.userId}`}>
          <div className={styles.inline}><Avatar person={{ id: m.userId, displayName: m.displayName }} /><div><div>{m.displayName}</div><div className={styles.muted}>{m.email}</div></div></div>
          <select className={styles.in} value={m.position} aria-label={t("positionOf", { name: m.displayName })} onChange={(e) => update(m.userId, { position: e.target.value })}>
            <option value="">—</option>
            {[...new Set([...(m.position ? [m.position] : []), ...POSITIONS])].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className={styles.in} value={m.role} aria-label={t("roleOf", { name: m.displayName })} onChange={(e) => update(m.userId, { role: e.target.value as TeamMember["role"] })}>
            {/* Guest เป็น Admin ของโปรเจกต์ไม่ได้ (A04) */}
            {(["admin", "member", "viewer"] as const).filter((r) => !(m.guest && r === "admin")).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
          </select>
          <input className={styles.in} type="number" min={0} max={168} value={m.capacityHoursWeek} aria-label={t("capacityOf", { name: m.displayName })} onChange={(e) => update(m.userId, { capacityHoursWeek: Math.max(0, Math.min(168, Math.round(Number(e.target.value) || 0))) })} />
          <button type="button" className={styles.x} aria-label={t("removeMember", { name: m.displayName })} onClick={() => onChange(members.filter((x) => x.userId !== m.userId))}>×</button>
        </div>
      ))}
      <span className={styles.hint}>{t("capacityHint")}</span>
    </div>
  );
}
