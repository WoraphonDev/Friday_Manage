"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, Select } from "@/components/ui";
import { DEFAULT_PROFILE, PROFILE_FIELDS, type CustomFieldType, type FieldMode, type FieldRule, type ProfileField } from "@/lib/field-profile";
import { FieldProfileEditor, type EditorValue } from "@/features/field-profile/field-profile-editor";
import type { ProjectTemplate, TemplateConfig } from "./types";
import styles from "./admin.module.css";

const TYPES: CustomFieldType[] = ["text", "number", "select", "multi_select", "user", "date"];
type TemplateCustomField = NonNullable<TemplateConfig["customFields"]>[number];

/** config → ค่าของตัวแก้ · Custom field ใน Template ยังไม่มี id จึงอ้างด้วยชื่อ (`cf:<ชื่อ>`) เหมือน API */
function toEditor(config: TemplateConfig): EditorValue {
  const fields = Object.fromEntries(PROFILE_FIELDS.map((f) => {
    const given = config.fields?.[f] ?? {};
    return [f, { task: given.task ?? "optional", subtask: given.subtask ?? "optional" }];
  })) as Record<ProfileField, FieldRule>;
  return {
    fields,
    columns: config.columns ?? DEFAULT_PROFILE.columns,
    custom: (config.customFields ?? []).map((f) => ({ key: `cf:${f.name}`, name: f.name, fieldType: f.fieldType, taskMode: f.taskMode ?? "optional", subtaskMode: f.subtaskMode ?? "optional" })),
  };
}

/**
 * แก้ชุดฟิลด์ของ Template ขององค์กร (Admin Console) · โปรเจกต์ที่สร้างไปแล้วไม่เปลี่ยนตาม (คัดลอกตอนสร้าง)
 * Custom field เพิ่ม / ลบได้ที่นี่ · ตัวเลือกของฟิลด์แบบเลือก คั่นด้วย ,
 */
export function TemplateFieldsDialog({ template, onClose, onSave }: {
  template: ProjectTemplate; onClose: () => void; onSave: (config: TemplateConfig) => Promise<boolean>;
}) {
  const t = useTranslations("admin-automation.admin.templates");
  const config = template.config ?? {};
  const [value, setValue] = useState<EditorValue>(() => toEditor(config));
  const [customs, setCustoms] = useState<TemplateCustomField[]>(config.customFields ?? []);
  const [adding, setAdding] = useState({ name: "", fieldType: "text" as CustomFieldType, choices: "" });
  const [busy, setBusy] = useState(false);
  const isChoice = adding.fieldType === "select" || adding.fieldType === "multi_select";
  const taken = (name: string) => customs.some((f) => f.name.toLowerCase() === name.trim().toLowerCase());

  function addCustom() {
    const name = adding.name.trim();
    if (!name || taken(name)) return;
    const choices = adding.choices.split(",").map((c) => c.trim()).filter(Boolean);
    const field: TemplateCustomField = { name, fieldType: adding.fieldType, ...(isChoice ? { options: { choices: choices.map((label, i) => ({ id: `c${i + 1}`, label })) } } : {}) };
    setCustoms([...customs, field]);
    setValue({ ...value, custom: [...value.custom, { key: `cf:${name}`, name, fieldType: adding.fieldType, taskMode: "optional", subtaskMode: "optional" }], columns: [...value.columns, `cf:${name}`] });
    setAdding({ name: "", fieldType: "text", choices: "" });
  }
  function removeCustom(name: string) {
    setCustoms(customs.filter((f) => f.name !== name));
    setValue({ ...value, custom: value.custom.filter((f) => f.name !== name), columns: value.columns.filter((c) => c !== `cf:${name}`) });
  }
  async function save() {
    setBusy(true);
    const modes = new Map(value.custom.map((f) => [f.name, f]));
    const next: TemplateConfig = {
      ...config,
      fields: value.fields,
      columns: value.columns,
      customFields: customs.map((f) => ({ ...f, taskMode: modes.get(f.name)?.taskMode as FieldMode, subtaskMode: modes.get(f.name)?.subtaskMode as FieldMode })),
    };
    const ok = await onSave(next);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog open size="wide" onOpenChange={(o) => !o && onClose()} title={t("fieldsTitle", { name: template.name })} description={t("fieldsHint")}>
      <div className={styles.dialogForm}>
        <FieldProfileEditor value={value} onChange={setValue} disabled={busy} />
        <div className={styles.fieldAdd}>
          <b>{t("customTitle")}</b>
          {customs.map((f) => (
            <span key={f.name} className={`${styles.pill} ${styles.neu}`}>
              {f.name}
              <button type="button" className={styles.pillX} aria-label={t("removeField", { name: f.name })} onClick={() => removeCustom(f.name)}>×</button>
            </span>
          ))}
          <div className={styles.fieldAddRow}>
            <Input label={t("fieldName")} value={adding.name} maxLength={120} error={adding.name && taken(adding.name) ? t("fieldTaken") : undefined} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
            <Select label={t("fieldType")} value={adding.fieldType} onChange={(e) => setAdding({ ...adding, fieldType: e.target.value as CustomFieldType })}>
              {TYPES.map((x) => <option key={x} value={x}>{t(`fieldTypes.${x}`)}</option>)}
            </Select>
            {isChoice && <Input label={t("choices")} hint={t("choicesHint")} value={adding.choices} onChange={(e) => setAdding({ ...adding, choices: e.target.value })} />}
            <Button onClick={addCustom} disabled={!adding.name.trim() || taken(adding.name) || (isChoice && !adding.choices.trim())}>{t("addField")}</Button>
          </div>
        </div>
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>{t("cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>{t("save")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
