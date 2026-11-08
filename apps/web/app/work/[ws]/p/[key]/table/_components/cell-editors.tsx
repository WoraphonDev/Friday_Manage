"use client";

import { useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Person } from "@/lib/types";
import styles from "./ot.module.css";

const SIZES = ["XS", "S", "M", "L", "XL"] as const;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * ช่องคนในแถว · Dev เลือกได้หลายคนและส่งครั้งเดียวตอนปิด (ไม่ส่งทุกคลิก จึงไม่ถามเหตุผล Baseline ซ้ำ)
 * · BA เลือกคนเดียว ส่งทันที
 */
export function PeopleCell({ label, people, value, multiple = false, onChange, children }: {
  label: string; people: Person[]; value: string[]; multiple?: boolean; onChange: (ids: string[]) => void; children: ReactNode;
}) {
  const t = useTranslations("overview-table.table.cell");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const current = multiple ? draft : value;
  function openChange(next: boolean) {
    if (next) setDraft(value);
    else if (multiple && !same(draft, value)) onChange(draft);
    setOpen(next);
  }
  function choose(id: string | null) {
    if (multiple) {
      setDraft((old) => (id === null ? [] : old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
      return;
    }
    setOpen(false);
    const next = id ? [id] : [];
    if (!same(next, value)) onChange(next);
  }
  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger asChild>
        <button type="button" className={styles.cellEdit} aria-label={label} aria-haspopup="listbox">{children}</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover combobox-popover" align="start" sideOffset={4}>
          <Command label={label}>
            <Command.Input aria-label={t("search")} placeholder={t("search")} />
            <Command.List aria-label={label}>
              <Command.Empty>{t("noPeople")}</Command.Empty>
              <Command.Item value="—" onSelect={() => choose(null)}>
                <span className={styles.noneAvatar} aria-hidden="true">—</span>
                <span>{t("nobody")}</span>
                {current.length === 0 && <Check size={16} aria-hidden="true" />}
              </Command.Item>
              {people.map((person) => (
                <Command.Item key={person.id} value={`${person.displayName} ${person.id}`} onSelect={() => choose(person.id)}>
                  <Avatar person={person} size="small" />
                  <span>{person.displayName}</span>
                  {current.includes(person.id) && <Check size={16} aria-hidden="true" />}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
          {multiple && (
            <div className={styles.popFoot}>
              <span>{t("chosen", { count: draft.length })}</span>
              <Popover.Close asChild><button type="button" className={styles.addb}>{t("done")}</button></Popover.Close>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Size กับ Man-Day อยู่ช่องเดียวกัน · เลือก Size แล้ว API คิด Man-Day และ Plan End ให้ */
export function SizeCell({ label, size, md, onChange, children }: {
  label: string; size: string | null; md: number | null; onChange: (body: { size: string } | { estimateMd: number }) => void; children: ReactNode;
}) {
  const t = useTranslations("overview-table.table.cell");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (next) setDraft(md === null ? "" : String(md)); setOpen(next); }}>
      <Popover.Trigger asChild>
        <button type="button" className={styles.cellEdit} aria-label={label}>{children}</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`popover ${styles.sizePop}`} align="start" sideOffset={4}>
          <div className={styles.sizeChoices} role="group" aria-label="Size">
            {SIZES.map((s) => (
              <button key={s} type="button" aria-pressed={size === s} onClick={() => { setOpen(false); if (s !== size) onChange({ size: s }); }}>{s}</button>
            ))}
          </div>
          <form className={styles.mdForm} onSubmit={(e) => {
            e.preventDefault();
            const value = Number(draft);
            if (!draft || !(value > 0)) return;
            setOpen(false);
            if (value !== md) onChange({ estimateMd: value });
          }}>
            <label>
              <span>Man-Day</span>
              <input type="number" min={0.25} max={9999} step={0.25} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("manDay")} />
            </label>
            <button type="submit" className={styles.addb}>{t("save")}</button>
          </form>
          <p className={styles.popHint}>{t("sizeHint")}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** วันที่ในแถว: แสดงเป็นข้อความ กดแล้วเป็นช่องวันที่ · ออกจากช่อง = บันทึก, Esc = ยกเลิก */
export function DateCell({ label, value, max, className, onChange, children }: {
  label: string; value: string | null; max?: string; className?: string; onChange: (value: string) => void; children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (editing) {
    return (
      <input
        className={styles.inline} type="date" autoFocus aria-label={label} defaultValue={value ?? ""} max={max}
        onKeyDown={(e) => {
          if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={(e) => {
          setEditing(false);
          const next = e.target.value;
          if (!cancelled.current && next && next !== value) onChange(next);
          cancelled.current = false;
        }}
      />
    );
  }
  return <button type="button" className={`${styles.cellEdit}${className ? ` ${className}` : ""}`} aria-label={label} onClick={() => setEditing(true)}>{children}</button>;
}

/** แถวเพิ่ม Sub-task ใต้ Task · Enter สร้างแล้วพิมพ์ตัวถัดไปต่อได้ · Esc ปิด */
export function SubtaskAdd({ base, parentKey, onCreated, onClose, onFullForm }: {
  base: string; parentKey: string; onCreated: (key: string) => Promise<void>; onClose: () => void; onFullForm: () => void;
}) {
  const t = useTranslations("overview-table.table.cell");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await api.post<{ key: string }>(`${base}/issues`, { type: "Task", parentKey, title: title.trim() });
      setTitle("");
      await onCreated(created.key);
    } catch (e) {
      // ประเภทงานบังคับฟิลด์เพิ่ม → ต้องใช้ฟอร์มเต็ม
      if (e instanceof ApiError && e.status === 400) onFullForm();
      else setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }
  return (
    <div className={styles.subAdd}>
      <span className={styles.typeSub} aria-hidden="true"><Check size={12} strokeWidth={3} /></span>
      <input
        autoFocus value={title} disabled={busy} maxLength={300}
        aria-label={t("subtaskTitle", { key: parentKey })} placeholder={t("subtaskPlaceholder")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") onClose();
        }}
      />
      <button type="button" className={styles.addb} disabled={busy || !title.trim()} onClick={() => void submit()}>{t("add")}</button>
      <button type="button" className={styles.subAddCancel} onClick={onClose}>{t("cancel")}</button>
      {error && <span role="alert" className={styles.dueLate}>{error}</span>}
    </div>
  );
}
