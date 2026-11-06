"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import {
  ACTION_TYPES, blankAction, CONDITION_FIELDS, errorText, incomplete, NUMERIC_FIELDS, PRIORITIES, SEVERITIES, STATUS_CATEGORIES, toBody, TRIGGERS,
  type Action, type ActionType, type Condition, type ConditionField, type DryRun, type FormOptions, type Op, type Rule, type RuleShape, type Trigger,
} from "./types";
import styles from "./automation.module.css";

type T = ReturnType<typeof useTranslations>;
const shape = (r: RuleShape): RuleShape => ({ name: r.name, trigger: r.trigger, triggerConfig: r.triggerConfig ?? {}, conditions: r.conditions ?? [], actions: r.actions ?? [], enabled: r.enabled });

/** ค่าที่เลือกได้ของแต่ละฟิลด์ (ไม่มี = พิมพ์เอง) */
function valueOptions(field: ConditionField, o: FormOptions | null, t: T): { value: string; label: string }[] | null {
  switch (field) {
    case "type": return o ? uniq(o.issueTypes.map((x) => x.name)).map((v) => ({ value: v, label: v })) : null;
    case "status": return o ? statusNames(o).map((v) => ({ value: v, label: v })) : null;
    case "statusCategory": return STATUS_CATEGORIES.map((v) => ({ value: v, label: t(`cat_${v}`) }));
    case "priority": return PRIORITIES.map((v) => ({ value: v, label: t(`prio_${v}`) }));
    case "severity": return SEVERITIES.map((v) => ({ value: v, label: t(`sev_${v}`) }));
    case "assignee": return o ? o.members.map((m) => ({ value: m.id, label: m.displayName })) : null;
    case "label": return o ? o.labels.map((l) => ({ value: l.name, label: l.name })) : null;
    case "module": return o ? o.modules.map((m) => ({ value: m.name, label: m.name })) : null;
    case "isSubtask": return [{ value: "true", label: t("yes") }, { value: "false", label: t("no") }];
    default: return null;
  }
}
const uniq = (v: string[]) => [...new Set(v)];
const statusNames = (o: FormOptions) => uniq(o.issueTypes.flatMap((x) => x.statuses.map((s) => s.name)));
const opsFor = (field: ConditionField): Op[] => (NUMERIC_FIELDS.includes(field) ? ["eq", "gt", "lt", "empty", "not_empty"] : field === "isSubtask" ? ["eq"] : ["eq", "in", "empty", "not_empty"]);

function personName(ref: string | undefined, o: FormOptions | null, t: T) {
  if (!ref) return "—";
  if (ref === "reporter" || ref === "creator") return t(`ref_${ref}`);
  return o?.members.find((m) => m.id === ref)?.displayName ?? ref;
}

/** "อ่านเป็นประโยค" ของฉบับร่าง (กฎที่บันทึกแล้วใช้ประโยคจาก API) */
export function draftSentence(r: RuleShape, o: FormOptions | null, t: T) {
  const cfg = r.triggerConfig as { from?: string; to?: string; frequency?: string; weekday?: number; time?: string };
  let when = t(`trig_${r.trigger}`);
  if (r.trigger === "status_changed") when = `${when}${cfg.from ? ` ${t("fromX", { x: cfg.from })}` : ""}${cfg.to ? ` ${t("toX", { x: cfg.to })}` : ""}`;
  if (r.trigger === "schedule") when = cfg.frequency === "weekly" ? t("schedWeekly", { day: cfg.weekday ? t(`day${cfg.weekday}`) : "…", time: cfg.time ?? "…" }) : t("schedDaily", { time: cfg.time ?? "…" });
  const conds = r.conditions.map((c) => {
    const opts = valueOptions(c.field, o, t);
    const show = (v: unknown) => opts?.find((x) => x.value === String(v))?.label ?? String(v);
    const val = c.op === "empty" || c.op === "not_empty" ? "" : Array.isArray(c.value) ? c.value.map(show).join(", ") : show(c.value ?? "…");
    return `${t(`field_${c.field}`)} ${c.not ? t("not") : ""}${t(`op_${c.op}`)}${val ? ` ${val}` : ""}`;
  });
  const acts = r.actions.map((a) => actionText(a, o, t));
  return t("sentence", { when, conds: conds.length ? ` ${t("if")} ${conds.join(` ${t("and")} `)}` : "", acts: acts.join(` ${t("then")} `) });
}
function actionText(a: Action, o: FormOptions | null, t: T) {
  switch (a.type) {
    case "set_status": return t("say_set_status", { x: a.status || "…" });
    case "assign": return a.mode === "clear" ? t("say_assign_clear") : t(a.mode === "set" ? "say_assign_set" : "say_assign_add", { x: personName(a.user, o, t) });
    case "set_priority": return t("say_set_priority", { x: t(`prio_${a.priority}`) });
    case "add_label": return t("say_add_label", { x: a.label || "…" });
    case "add_watcher": return t("say_add_watcher", { x: personName(a.user, o, t) });
    case "create_subtask": return t("say_create_subtask", { x: a.title || "…" });
    case "comment": return t("say_comment", { x: a.body.slice(0, 40) || "…" });
    case "notify": return t("say_notify", { x: a.to === "users" ? (a.userIds ?? []).map((u) => personName(u, o, t)).join(", ") || "…" : t(`to_${a.to}`) });
  }
}

export function RuleEditor({
  base,
  rule,
  initial,
  options,
  onSaved,
  onDeleted,
  onCancelDraft,
}: {
  base: string;
  /** null = ฉบับร่างใหม่ (จากแม่แบบหรือกฎว่าง) */
  rule: Rule | null;
  initial: RuleShape;
  options: FormOptions | null;
  onSaved: (saved: Rule) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  onCancelDraft?: () => void;
}) {
  const t = useTranslations("admin-automation.automation");
  const toast = useToast();
  const [r, setR] = useState<RuleShape>(() => shape(initial));
  const [busy, setBusy] = useState(false);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [issueKey, setIssueKey] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const dirty = !rule || JSON.stringify(toBody(r)) !== JSON.stringify(toBody(shape(rule)));
  const set = (p: Partial<RuleShape>) => {
    setR((x) => ({ ...x, ...p }));
    setDry(null);
  };
  const setCond = (i: number, c: Partial<Condition>) => set({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const setAct = (i: number, a: Action) => set({ actions: r.actions.map((x, j) => (j === i ? a : x)) });
  const statuses = options ? statusNames(options) : [];
  const people = options?.members ?? [];

  async function save() {
    setBusy(true);
    try {
      const body = toBody(r);
      const saved = rule ? await api.request<Rule>(`${base}/automations/${rule.id}`, { method: "PATCH", body }) : await api.post<Rule>(`${base}/automations`, body);
      toast({ message: t("saved", { name: saved.name }) });
      await onSaved(saved);
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }
  async function dryRun() {
    if (!rule) return;
    setBusy(true);
    try {
      setDry(await api.post<DryRun>(`${base}/automations/${rule.id}/dry-run`, issueKey.trim() ? { issueKey: issueKey.trim() } : {}));
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setBusy(false);
    }
  }

  const cfg = r.triggerConfig as { from?: string; to?: string; frequency?: string; weekday?: number; time?: string };
  const statusSelect = (value: string | undefined, onChange: (v: string) => void, label: string, empty?: string) =>
    statuses.length ? (
      <select className={styles.in} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty ?? t("pick")}</option>
        {uniq([...statuses, ...(value ? [value] : [])]).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    ) : (
      <input className={styles.in} aria-label={label} value={value ?? ""} placeholder={empty} onChange={(e) => onChange(e.target.value)} />
    );
  const personSelect = (value: string | undefined, onChange: (v: string) => void, label: string, refs = true) => (
    <select className={styles.in} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("pick")}</option>
      {refs && <option value="reporter">{t("ref_reporter")}</option>}
      {refs && <option value="creator">{t("ref_creator")}</option>}
      {people.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
    </select>
  );

  return (
    <section className={`${styles.card} ${styles.editor}`} aria-label={t("editorLabel")}>
      <div className={styles.edHead}>
        <input className={`${styles.in} ${styles.name}`} type="text" value={r.name} aria-label={t("name")} placeholder={t("namePlaceholder")} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        <div className={styles.row}>
          <Button disabled={!rule || dirty || busy} title={!rule || dirty ? t("saveFirst") : undefined} onClick={() => void dryRun()}>{t("dryRun")}</Button>
          <Button variant="primary" disabled={!dirty || busy || incomplete(r)} onClick={() => void save()}>{busy ? t("saving") : t("save")}</Button>
        </div>
      </div>
      <div className={styles.edBody}>
        <div className={styles.blk}>
          <div className={`${styles.bh} ${styles.when}`}><span className={`${styles.pill} ${styles.whenPill}`}>{t("whenTag")}</span>{t("whenTitle")}</div>
          <select className={styles.in} aria-label={t("trigger")} value={r.trigger} onChange={(e) => set({ trigger: e.target.value as Trigger, triggerConfig: e.target.value === "schedule" ? { frequency: "daily", time: "09:30" } : {} })}>
            {TRIGGERS.map((x) => <option key={x} value={x}>{t(`trig_${x}`)}</option>)}
          </select>
          {r.trigger === "status_changed" && (
            <div className={styles.row}>
              {statusSelect(cfg.from, (v) => set({ triggerConfig: { ...cfg, from: v || undefined } }), t("fromStatus"), t("anyStatus"))}
              <span aria-hidden="true">→</span>
              {statusSelect(cfg.to, (v) => set({ triggerConfig: { ...cfg, to: v || undefined } }), t("toStatus"), t("anyStatus"))}
            </div>
          )}
          {r.trigger === "schedule" && (
            <div className={styles.row}>
              <select className={styles.in} aria-label={t("frequency")} value={cfg.frequency ?? "daily"} onChange={(e) => set({ triggerConfig: { ...cfg, frequency: e.target.value, weekday: e.target.value === "weekly" ? (cfg.weekday ?? 1) : undefined } })}>
                <option value="daily">{t("daily")}</option>
                <option value="weekly">{t("weekly")}</option>
              </select>
              {cfg.frequency === "weekly" && (
                <select className={styles.in} aria-label={t("weekday")} value={cfg.weekday ?? 1} onChange={(e) => set({ triggerConfig: { ...cfg, weekday: Number(e.target.value) } })}>
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{t(`day${d}`)}</option>)}
                </select>
              )}
              <input className={styles.in} type="time" aria-label={t("time")} value={cfg.time ?? ""} onChange={(e) => set({ triggerConfig: { ...cfg, time: e.target.value } })} />
            </div>
          )}
        </div>
        <div className={styles.line} />
        <div className={styles.blk}>
          <div className={`${styles.bh} ${styles.ifC}`}><span className={`${styles.pill} ${styles.ifPill}`}>{t("ifTag")}</span>{t("ifTitle")}</div>
          {r.conditions.map((c, i) => {
            const opts = valueOptions(c.field, options, t);
            const needsValue = c.op !== "empty" && c.op !== "not_empty";
            return (
              <div key={i} className={styles.row}>
                <select className={styles.in} aria-label={t("condField", { n: i + 1 })} value={c.field} onChange={(e) => { const field = e.target.value as ConditionField; setCond(i, { field, op: opsFor(field)[0], value: undefined }); }}>
                  {CONDITION_FIELDS.map((f) => <option key={f} value={f}>{t(`field_${f}`)}</option>)}
                </select>
                <select className={`${styles.in} ${styles.narrow}`} aria-label={t("condNot", { n: i + 1 })} value={c.not ? "not" : "is"} onChange={(e) => setCond(i, { not: e.target.value === "not" })}>
                  <option value="is">{t("is")}</option>
                  <option value="not">{t("isNot")}</option>
                </select>
                <select className={`${styles.in} ${styles.narrow}`} aria-label={t("condOp", { n: i + 1 })} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Op, value: undefined })}>
                  {opsFor(c.field).map((op) => <option key={op} value={op}>{t(`op_${op}`)}</option>)}
                </select>
                {needsValue && (opts && c.op === "eq" ? (
                  <select className={styles.in} aria-label={t("condValue", { n: i + 1 })} value={c.value === undefined ? "" : String(c.value)} onChange={(e) => setCond(i, { value: c.field === "isSubtask" ? e.target.value === "true" : e.target.value || undefined })}>
                    <option value="">{t("pick")}</option>
                    {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    className={styles.in}
                    aria-label={t("condValue", { n: i + 1 })}
                    type={NUMERIC_FIELDS.includes(c.field) ? "number" : "text"}
                    placeholder={c.op === "in" ? t("listHint") : undefined}
                    value={Array.isArray(c.value) ? c.value.join(", ") : c.value === undefined ? "" : String(c.value)}
                    onChange={(e) => {
                      const v = e.target.value;
                      const value = c.op === "in" ? v.split(",").map((x) => x.trim()).filter(Boolean) : NUMERIC_FIELDS.includes(c.field) ? (v === "" ? undefined : Number(v)) : v || undefined;
                      setCond(i, { value });
                    }}
                  />
                ))}
                <button type="button" className={styles.x} aria-label={t("removeCond", { n: i + 1 })} onClick={() => set({ conditions: r.conditions.filter((_, j) => j !== i) })}>×</button>
              </div>
            );
          })}
          <div><Button size="small" disabled={r.conditions.length >= 10} onClick={() => set({ conditions: [...r.conditions, { field: "type", op: "eq", not: false }] })}>{t("addCond")}</Button></div>
        </div>
        <div className={styles.line} />
        <div className={styles.blk}>
          <div className={`${styles.bh} ${styles.thenC}`}><span className={`${styles.pill} ${styles.thenPill}`}>{t("thenTag")}</span>{t("thenTitle")}</div>
          {r.actions.map((a, i) => (
            <div key={i} className={styles.row}>
              <span className={styles.idx}>{i + 1}</span>
              <select className={styles.in} aria-label={t("actType", { n: i + 1 })} value={a.type} onChange={(e) => setAct(i, blankAction(e.target.value as ActionType))}>
                {ACTION_TYPES.map((x) => <option key={x} value={x}>{t(`act_${x}`)}</option>)}
              </select>
              <ActionFields a={a} i={i} t={t} onChange={(next) => setAct(i, next)} statusSelect={statusSelect} personSelect={personSelect} people={people} labels={options?.labels ?? []} />
              <button type="button" className={styles.x} aria-label={t("removeAct", { n: i + 1 })} disabled={r.actions.length <= 1} onClick={() => set({ actions: r.actions.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <div><Button size="small" disabled={r.actions.length >= 10} onClick={() => set({ actions: [...r.actions, blankAction("notify")] })}>{t("addAct")}</Button></div>
        </div>
        <div className={styles.sentence}><b>{t("readAs")}</b> {dirty ? draftSentence(r, options, t) : rule!.sentence}</div>
        {rule && !dirty && (
          <div className={styles.row}>
            <input className={styles.in} style={{ maxWidth: 220 }} aria-label={t("dryIssue")} placeholder={t("dryIssuePlaceholder")} value={issueKey} onChange={(e) => setIssueKey(e.target.value)} />
            <span className={styles.muted}>{t("dryIssueHint")}</span>
          </div>
        )}
        {(!rule || dirty) && <span className={styles.muted}>{t("saveFirst")}</span>}
        {dry && (
          <div role="status" className={styles.dry}>
            <b className={styles.dryTitle}>{t("dryTitle")}</b>
            <span>{t("dryMatched", { matched: dry.matched, checked: dry.checked })}</span>
            {dry.items.map((it) => (
              <div key={it.key}>
                <b className={styles.mono}>{it.key}</b> {it.title} <span className={styles.muted}>· {it.status}</span>
                <ul className={styles.would}>
                  {it.wouldDo.map((w, j) => <li key={j}>{w.text}{w.warning && <span className={styles.warnText}> · {w.warning}</span>}</li>)}
                </ul>
              </div>
            ))}
            {dry.notes.map((n) => <span key={n} className={styles.muted}>{n}</span>)}
          </div>
        )}
        <div className={styles.footRow}>
          <span className={styles.muted}>{t("loopNote")}</span>
          {rule ? <Button variant="ghost" onClick={() => setRemoveOpen(true)}>{t("delete")}</Button> : onCancelDraft && <Button variant="ghost" onClick={onCancelDraft}>{t("cancel")}</Button>}
        </div>
      </div>
      {rule && (
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={t("deleteConfirm", { name: rule.name })}
          description={t("deleteHint")}
          confirmLabel={t("delete")}
          successMessage={t("deleted")}
          onConfirm={async () => {
            await api.delete(`${base}/automations/${rule.id}`);
            await onDeleted();
          }}
        />
      )}
    </section>
  );
}

function ActionFields({
  a, i, t, onChange, statusSelect, personSelect, people, labels,
}: {
  a: Action;
  i: number;
  t: T;
  onChange: (a: Action) => void;
  statusSelect: (value: string | undefined, onChange: (v: string) => void, label: string) => React.ReactNode;
  personSelect: (value: string | undefined, onChange: (v: string) => void, label: string, refs?: boolean) => React.ReactNode;
  people: FormOptions["members"];
  labels: FormOptions["labels"];
}) {
  const label = t("actValue", { n: i + 1 });
  switch (a.type) {
    case "set_status":
      return statusSelect(a.status, (v) => onChange({ ...a, status: v }), label);
    case "assign":
      return (
        <>
          <select className={`${styles.in} ${styles.narrow}`} aria-label={t("assignMode", { n: i + 1 })} value={a.mode} onChange={(e) => onChange({ ...a, mode: e.target.value as "add" | "set" | "clear" })}>
            <option value="add">{t("mode_add")}</option>
            <option value="set">{t("mode_set")}</option>
            <option value="clear">{t("mode_clear")}</option>
          </select>
          {a.mode !== "clear" && personSelect(a.user, (v) => onChange({ ...a, user: v }), label)}
        </>
      );
    case "set_priority":
      return (
        <select className={styles.in} aria-label={label} value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value as (typeof PRIORITIES)[number] })}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{t(`prio_${p}`)}</option>)}
        </select>
      );
    case "add_label":
      return (
        <>
          <input className={styles.in} aria-label={label} list={`labels-${i}`} value={a.label} maxLength={80} onChange={(e) => onChange({ ...a, label: e.target.value })} />
          <datalist id={`labels-${i}`}>{labels.map((l) => <option key={l.id} value={l.name} />)}</datalist>
        </>
      );
    case "add_watcher":
      return personSelect(a.user, (v) => onChange({ ...a, user: v }), label);
    case "create_subtask":
      return (
        <>
          <input className={styles.in} aria-label={label} placeholder={t("subtaskTitle")} value={a.title} maxLength={300} onChange={(e) => onChange({ ...a, title: e.target.value })} />
          {personSelect(a.assignee, (v) => onChange({ ...a, assignee: v || undefined }), t("subtaskAssignee", { n: i + 1 }))}
        </>
      );
    case "comment":
      return <input className={styles.in} aria-label={label} placeholder={t("commentBody")} value={a.body} maxLength={2000} onChange={(e) => onChange({ ...a, body: e.target.value })} />;
    case "notify":
      return (
        <>
          <select className={`${styles.in} ${styles.narrow}`} aria-label={t("notifyTo", { n: i + 1 })} value={a.to} onChange={(e) => onChange({ ...a, to: e.target.value as typeof a.to, userIds: e.target.value === "users" ? (a.userIds ?? []) : undefined })}>
            {(["assignees", "reporter", "project_owner", "users"] as const).map((x) => <option key={x} value={x}>{t(`to_${x}`)}</option>)}
          </select>
          {a.to === "users" && (
            <select className={styles.in} aria-label={t("notifyUser", { n: i + 1 })} value={a.userIds?.[0] ?? ""} onChange={(e) => onChange({ ...a, userIds: e.target.value ? [e.target.value] : [] })}>
              <option value="">{t("pick")}</option>
              {people.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
            </select>
          )}
          <input className={styles.in} aria-label={label} placeholder={t("notifyMessage")} value={a.message} maxLength={500} onChange={(e) => onChange({ ...a, message: e.target.value })} />
        </>
      );
  }
}
