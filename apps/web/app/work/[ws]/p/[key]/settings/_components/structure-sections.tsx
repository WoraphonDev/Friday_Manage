"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { CustomFieldDef, FieldMode, FieldProfile } from "@/lib/field-profile";
import { FieldProfileEditor, TemplateSource, type EditorValue } from "@/features/field-profile/field-profile-editor";
import { projectEndpoint, SectionHead } from "./shared";
import { errorText, isForbidden, move, patchPlain, type CustomField, type IssueType, type IssueTypes, type Label, type Member, type Module } from "./types";
import styles from "./settings.module.css";
import { DEFAULT_ITEM_COLOR, readableColor, tint } from "@/lib/colors";

const FIELD_TYPES: CustomField["fieldType"][] = ["text", "number", "select", "multi_select", "user", "date"];
const MODES: FieldMode[] = ["optional", "required", "hidden"];

function useRun(reload: () => Promise<unknown>) {
  const toast = useToast();
  const t = useTranslations("project-settings-new.settings");
  return async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast({ message: success });
      return true;
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
      return false;
    } finally {
      await reload();
    }
  };
}

export function TypesSection({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("project-settings-new.settings.types");
  const cache = useQueryClient();
  const base = projectEndpoint(ws, projectKey);
  const prefix = ["workspace", ws, "project", projectKey, "settings"];
  const types = useQuery({ queryKey: [...prefix, "issue-types"], queryFn: () => api.get<IssueTypes>(`${base}/issue-types`) });
  const fields = useQuery({ queryKey: [...prefix, "custom-fields"], queryFn: () => api.get<{ items: CustomField[] }>(`${base}/custom-fields`) });
  const labels = useQuery({ queryKey: [...prefix, "labels"], queryFn: () => api.get<{ items: Label[] }>(`${base}/labels`) });
  const run = useRun(() => Promise.all(["issue-types", "custom-fields", "labels"].map((k) => cache.invalidateQueries({ queryKey: [...prefix, k] }))));
  const [editing, setEditing] = useState<IssueType | null>(null);
  const [required, setRequired] = useState<string[]>([]);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [field, setField] = useState({ name: "", fieldType: "text" as CustomField["fieldType"], choices: "", taskMode: "optional" as FieldMode, subtaskMode: "optional" as FieldMode });
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState({ name: "", color: DEFAULT_ITEM_COLOR });
  const [removing, setRemoving] = useState<{ kind: "field" | "label"; id: string; name: string } | null>(null);

  const error = types.error ?? fields.error ?? labels.error;
  if (isForbidden(error)) return <Forbidden />;
  if (error) return <ErrorState error={error} retry={() => { void types.refetch(); void fields.refetch(); void labels.refetch(); }} />;
  if (!types.data || !fields.data || !labels.data) return <LoadingState />;
  const options = types.data.requiredFieldOptions;
  const fieldLabel = (key: string) => options.find((o) => o.key === key)?.label ?? key;
  const isChoice = field.fieldType === "select" || field.fieldType === "multi_select";

  async function saveRequired() {
    if (!editing) return;
    if (await run(() => patchPlain(`${base}/issue-types/${editing.id}`, { requiredFields: required }), t("saved"))) setEditing(null);
  }
  async function addField() {
    const choices = field.choices.split(",").map((c) => c.trim()).filter(Boolean);
    const body = { name: field.name.trim(), fieldType: field.fieldType, taskMode: field.taskMode, subtaskMode: field.subtaskMode, ...(isChoice ? { options: { choices: choices.map((c) => ({ label: c })) } } : {}) };
    if (await run(() => api.post(`${base}/custom-fields`, body), t("fieldAdded"))) {
      setFieldOpen(false);
      setField({ name: "", fieldType: "text", choices: "", taskMode: "optional", subtaskMode: "optional" });
      // ฟิลด์ใหม่ขึ้นเป็นคอลัมน์ใน Table · ชุดฟิลด์ / ฟอร์มสร้างงานต้องโหลดใหม่
      await cache.invalidateQueries({ queryKey: [...prefix, "field-profile"] });
      await cache.invalidateQueries({ queryKey: queryKeys.project(ws, projectKey), exact: true });
    }
  }
  async function addLabel() {
    if (await run(() => api.post(`${base}/labels`, { name: label.name.trim(), color: label.color }), t("labelAdded"))) {
      setLabelOpen(false);
      setLabel({ name: "", color: DEFAULT_ITEM_COLOR });
    }
  }

  return (
    <>
      <SectionHead title={t("title")} description={t("description")} />
      <div className={styles.sb}>
        {types.data.items.map((type) => (
          <div key={type.id} className={styles.typeRow}>
            <span className={styles.ty} style={{ background: type.color ?? "var(--muted)" }} aria-hidden="true" />
            <div>
              <b>{type.name}</b> <span className={styles.muted}>· {t("workflowOf", { name: type.workflow.name })}</span>
              <div className={styles.muted}>{t("requiredOf", { fields: type.requiredFields.map(fieldLabel).join(", ") })}</div>
            </div>
            <label className={styles.check}>
              <input type="checkbox" checked={type.enabled} aria-label={t("enableOf", { name: type.name })} onChange={(e) => void run(() => patchPlain(`${base}/issue-types/${type.id}`, { enabled: e.target.checked }), t("saved"))} />
              {t("enabled")}
            </label>
            <Button size="small" onClick={() => { setEditing(type); setRequired(type.requiredFields); }}>{t("editFields")}</Button>
          </div>
        ))}
        <FieldSetBlock ws={ws} projectKey={projectKey} />
        <div className={styles.fld}>
          <span className={styles.lb}>{t("customFields")}</span>
          <div className={styles.pills}>
            {fields.data.items.map((f) => (
              <span key={f.id} className={styles.pill}>
                {f.name} ({t(`fieldTypes.${f.fieldType}`)})
                <button type="button" className={styles.pillBtn} aria-label={t("removeOf", { name: f.name })} onClick={() => setRemoving({ kind: "field", id: f.id, name: f.name })}>×</button>
              </span>
            ))}
            {!fields.data.items.length && <span className={styles.muted}>{t("noFields")}</span>}
            <Button size="small" onClick={() => setFieldOpen(true)}>{t("addField")}</Button>
          </div>
        </div>
        <div className={styles.fld}>
          <span className={styles.lb}>{t("labels")}</span>
          <div className={styles.pills}>
            {labels.data.items.map((l) => (
              <span key={l.id} className={styles.pill} style={l.color ? { background: tint(l.color, 12), color: readableColor(l.color) } : undefined}>
                {l.name}
                <button type="button" className={styles.pillBtn} aria-label={t("removeOf", { name: l.name })} onClick={() => setRemoving({ kind: "label", id: l.id, name: l.name })}>×</button>
              </span>
            ))}
            {!labels.data.items.length && <span className={styles.muted}>{t("noLabels")}</span>}
            <Button size="small" onClick={() => setLabelOpen(true)}>{t("addLabel")}</Button>
          </div>
        </div>
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={t("requiredTitle", { name: editing?.name ?? "" })} description={t("requiredHint")}>
        <div className={styles.dialogForm}>
          {options.map((o) => (
            <label key={o.key} className={styles.check}>
              <input
                type="checkbox"
                checked={o.key === "title" || required.includes(o.key)}
                disabled={o.key === "title"}
                onChange={(e) => setRequired((r) => (e.target.checked ? [...r, o.key] : r.filter((k) => k !== o.key)))}
              />
              {o.label}
            </label>
          ))}
          <div className="dialog-actions">
            <Button onClick={() => setEditing(null)}>{t("cancel")}</Button>
            <Button variant="primary" onClick={() => void saveRequired()}>{t("save")}</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={fieldOpen} onOpenChange={setFieldOpen} title={t("addFieldTitle")}>
        <form className={styles.dialogForm} onSubmit={(e) => { e.preventDefault(); void addField(); }}>
          <Input label={t("fieldName")} value={field.name} onChange={(e) => setField({ ...field, name: e.target.value })} maxLength={120} required />
          <Select label={t("fieldType")} value={field.fieldType} onChange={(e) => setField({ ...field, fieldType: e.target.value as CustomField["fieldType"] })}>
            {FIELD_TYPES.map((x) => <option key={x} value={x}>{t(`fieldTypes.${x}`)}</option>)}
          </Select>
          {isChoice && <Input label={t("choices")} hint={t("choicesHint")} value={field.choices} onChange={(e) => setField({ ...field, choices: e.target.value })} />}
          <Select label={t("taskMode")} value={field.taskMode} onChange={(e) => setField({ ...field, taskMode: e.target.value as FieldMode })}>
            {MODES.map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
          </Select>
          <Select label={t("subtaskMode")} value={field.subtaskMode} onChange={(e) => setField({ ...field, subtaskMode: e.target.value as FieldMode })}>
            {MODES.map((m) => <option key={m} value={m}>{t(`modes.${m}`)}</option>)}
          </Select>
          <div className="dialog-actions">
            <Button onClick={() => setFieldOpen(false)}>{t("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!field.name.trim() || (isChoice && !field.choices.trim())}>{t("add")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={labelOpen} onOpenChange={setLabelOpen} title={t("addLabelTitle")}>
        <form className={styles.dialogForm} onSubmit={(e) => { e.preventDefault(); void addLabel(); }}>
          <Input label={t("labelName")} value={label.name} onChange={(e) => setLabel({ ...label, name: e.target.value })} maxLength={60} required />
          <Input label={t("labelColor")} type="color" value={label.color} onChange={(e) => setLabel({ ...label, color: e.target.value })} />
          <div className="dialog-actions">
            <Button onClick={() => setLabelOpen(false)}>{t("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!label.name.trim()}>{t("add")}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("removeTitle", { name: removing?.name ?? "" })}
        description={removing?.kind === "field" ? t("removeFieldHint") : t("removeLabelHint")}
        confirmLabel={t("remove")}
        successMessage={t("removed", { name: removing?.name ?? "" })}
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`${base}/${removing.kind === "field" ? "custom-fields" : "labels"}/${removing.id}`);
          await cache.invalidateQueries({ queryKey: [...prefix, removing.kind === "field" ? "custom-fields" : "labels"] });
          if (removing.kind === "field") await cache.invalidateQueries({ queryKey: [...prefix, "field-profile"] });
        }}
      />
    </>
  );
}

/**
 * ชุดฟิลด์ของ Task / Sub-task + คอลัมน์ Table (ผู้ใช้ตัดสิน 2026-11-09: แก้หลังสร้างโปรเจกต์ได้ · ซ่อนแล้วค่าเดิมยังอยู่)
 * ฟิลด์มาตรฐานบันทึกด้วย PUT field-profile · โหมดของ Custom field บันทึกทีละฟิลด์ด้วย PATCH custom-fields
 */
function FieldSetBlock({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("project-settings-new.settings.types");
  const cache = useQueryClient();
  const toast = useToast();
  const base = projectEndpoint(ws, projectKey);
  const queryKey = ["workspace", ws, "project", projectKey, "settings", "field-profile"];
  const profile = useQuery({ queryKey, queryFn: () => api.get<{ fieldProfile: FieldProfile; customFields: CustomFieldDef[] }>(`${base}/field-profile`) });
  const [draft, setDraft] = useState<EditorValue | null>(null);
  const [saving, setSaving] = useState(false);
  if (profile.error) return <ErrorState error={profile.error} retry={() => void profile.refetch()} />;
  if (!profile.data) return <LoadingState />;
  const original: EditorValue = {
    fields: profile.data.fieldProfile.fields,
    columns: profile.data.fieldProfile.columns,
    custom: profile.data.customFields.map((f) => ({ key: `cf:${f.id}`, name: f.name, fieldType: f.fieldType, taskMode: f.taskMode, subtaskMode: f.subtaskMode })),
  };
  // รายการ Custom field เปลี่ยน (เพิ่ม / ลบ) ระหว่างแก้ = เริ่มร่างใหม่จากค่าล่าสุด
  const value = draft && draft.custom.map((f) => f.key).join() === original.custom.map((f) => f.key).join() ? draft : original;
  const dirty = JSON.stringify(value) !== JSON.stringify(original);
  async function save() {
    setSaving(true);
    try {
      await api.put(`${base}/field-profile`, { fields: value.fields, columns: value.columns });
      for (const f of value.custom) {
        const before = original.custom.find((x) => x.key === f.key);
        if (before && (before.taskMode !== f.taskMode || before.subtaskMode !== f.subtaskMode)) {
          await patchPlain(`${base}/custom-fields/${f.key.slice(3)}`, { taskMode: f.taskMode, subtaskMode: f.subtaskMode });
        }
      }
      // คอลัมน์ที่ซ่อนอยู่ตอนส่ง PUT ยังถูกตัด จึงส่งลำดับคอลัมน์ซ้ำหลังโหมดของ Custom field เปลี่ยน
      if (value.custom.some((f) => value.columns.includes(f.key))) await api.put(`${base}/field-profile`, { columns: value.columns });
      toast({ message: t("fieldSetSaved") });
      setDraft(null);
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setSaving(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey }),
        cache.invalidateQueries({ queryKey: ["workspace", ws, "project", projectKey, "settings", "custom-fields"] }),
        cache.invalidateQueries({ queryKey: queryKeys.project(ws, projectKey), exact: true }),
        cache.invalidateQueries({ queryKey: ["table", ws, projectKey] }),
        cache.invalidateQueries({ queryKey: ["issue-form-options", ws, projectKey] }),
      ]);
    }
  }
  return (
    <div className={styles.fld}>
      <span className={styles.lb}>{t("fieldSet")} <TemplateSource template={profile.data.fieldProfile.template} /></span>
      <FieldProfileEditor value={value} onChange={setDraft} disabled={saving} />
      <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>{t("fieldSetSave")}</Button>
        {dirty && <Button disabled={saving} onClick={() => setDraft(null)}>{t("cancel")}</Button>}
      </div>
    </div>
  );
}

export function ModulesSection({ ws, projectKey, members }: { ws: string; projectKey: string; members: Member[] }) {
  const t = useTranslations("project-settings-new.settings.modules");
  const cache = useQueryClient();
  const base = projectEndpoint(ws, projectKey);
  const queryKey = ["workspace", ws, "project", projectKey, "settings", "modules"];
  const modules = useQuery({ queryKey, queryFn: () => api.get<{ items: Module[] }>(`${base}/modules`) });
  const run = useRun(() => cache.invalidateQueries({ queryKey }));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<Module | null>(null);
  const [moveTo, setMoveTo] = useState("");

  if (isForbidden(modules.error)) return <Forbidden />;
  if (modules.error) return <ErrorState error={modules.error} retry={() => void modules.refetch()} />;
  if (!modules.data) return <LoadingState />;
  const items = modules.data.items;
  const people = members.filter((m) => m.active);

  async function add() {
    if (await run(() => api.post(`${base}/modules`, { name: name.trim() }), t("added"))) {
      setAdding(false);
      setName("");
    }
  }
  async function remove() {
    if (!removing) return;
    const body = removing.issueCount ? { moveTo } : {};
    if (await run(() => api.delete(`${base}/modules/${removing.id}`, { body }), t("removed", { name: removing.name }))) setRemoving(null);
  }

  return (
    <>
      <SectionHead title={t("title")} description={t("description")} />
      <div className={styles.sb}>
        {!items.length && <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />}
        <div className={styles.list}>
          {items.map((m, i) => (
            <div key={`${m.id}:${m.name}:${m.owner?.id ?? ""}`} className={styles.modRow} data-testid={`module-${m.name}`}>
              <span className={styles.order}>
                <button type="button" className={styles.icon} disabled={i === 0} aria-label={t("moveUp", { name: m.name })} onClick={() => void run(() => api.post(`${base}/modules/reorder`, { ids: move(items, i, -1).map((x) => x.id) }))}>↑</button>
                <button type="button" className={styles.icon} disabled={i === items.length - 1} aria-label={t("moveDown", { name: m.name })} onClick={() => void run(() => api.post(`${base}/modules/reorder`, { ids: move(items, i, 1).map((x) => x.id) }))}>↓</button>
              </span>
              <input
                className={styles.in}
                defaultValue={m.name}
                maxLength={120}
                aria-label={t("nameOf", { name: m.name })}
                style={m.color ? { borderLeft: `4px solid ${m.color}` } : undefined}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== m.name) void run(() => patchPlain(`${base}/modules/${m.id}`, { name: v }), t("saved")); }}
              />
              <select className={`${styles.in} ${styles.hs}`} value={m.owner?.id ?? ""} aria-label={t("ownerOf", { name: m.name })} onChange={(e) => void run(() => patchPlain(`${base}/modules/${m.id}`, { ownerUserId: e.target.value || null }), t("saved"))}>
                <option value="">{t("noOwner")}</option>
                {m.owner && !people.some((p) => p.userId === m.owner?.id) && <option value={m.owner.id}>{m.owner.displayName}</option>}
                {people.map((p) => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}
              </select>
              <span className={`${styles.muted} ${styles.hs}`}>{t("issues", { count: m.issueCount })}</span>
              <button type="button" className={styles.x} aria-label={t("remove", { name: m.name })} onClick={() => { setRemoving(m); setMoveTo(items.find((x) => x.id !== m.id)?.id ?? ""); }}>×</button>
            </div>
          ))}
        </div>
        <div>
          <Button onClick={() => setAdding(true)}>{t("add")}</Button>
        </div>
      </div>

      <Dialog open={adding} onOpenChange={setAdding} title={t("addTitle")}>
        <form className={styles.dialogForm} onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)}>{t("cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>{t("addConfirm")}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={t("removeTitle", { name: removing?.name ?? "" })}>
        <div className={styles.dialogForm}>
          {removing?.issueCount ? (
            <>
              <p className={styles.muted}>{t("removeHasIssues", { count: removing.issueCount })}</p>
              <Select label={t("moveTo")} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {items.filter((x) => x.id !== removing.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </>
          ) : (
            <p className={styles.muted}>{t("removeEmpty")}</p>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
            <Button variant="danger" disabled={!!removing?.issueCount && !moveTo} onClick={() => void remove()}>{t("removeConfirm")}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
