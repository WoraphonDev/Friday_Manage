"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateRange, today as todayIso, type YearFormat } from "@/lib/format";
import { createSprintSeries, openSprint, sprintSeries, suggestedStart, useRefreshSprints, useSprints, type Sprint } from "./sprints";
import styles from "./sprints.module.css";

/** ป้าย Sprint สั้น ๆ (S2) · สีบอกสถานะ: กำลังทำ = เขียว · ปิดแล้ว = เทา · วางแผน = ขอบ */
export function SprintBadge({ sprint, full = false }: { sprint: Sprint | null | undefined; full?: boolean }) {
  const t = useTranslations("sprints");
  if (!sprint) return <span className={`${styles.badge} ${styles.none}`}>{full ? t("noSprint") : "—"}</span>;
  const tone = sprint.status === "active" ? styles.active : sprint.status === "completed" ? styles.done : "";
  return <span className={`${styles.badge} ${tone}`} title={`${sprint.name} · ${t(`status.${sprint.status}`)}`}>{full ? sprint.name : `S${sprint.number}`}</span>;
}

/** บรรทัดรองของ Sprint ในรายการ: ช่วงวัน + สถานะ */
function sprintMeta(sprint: Sprint, year: YearFormat, t: ReturnType<typeof useTranslations>) {
  const range = formatDateRange(sprint.startDate, sprint.endDate, year);
  return sprint.status === "planning" ? range : `${range} · ${t(`status.${sprint.status}`)}`;
}

/**
 * เลือก Sprint ของงาน (ช่องในตาราง / หน้า Task) · Sprint ที่ปิดแล้วแสดงไว้แต่เลือกไม่ได้
 * onCreate = เปิดหน้าต่างสร้าง Sprint (ไม่มีสิทธิ์จัดการ Sprint = ไม่แสดงปุ่ม)
 */
export function SprintPicker({ label, sprints, value, year, onChange, onCreate, children, triggerClassName }: {
  /** undefined = ไม่มีค่าปัจจุบัน (เช่น ย้ายหลายงานพร้อมกัน) */
  label: string; sprints: Sprint[]; value?: string | null; year: YearFormat;
  onChange: (id: string | null) => void; onCreate?: () => void; children: ReactNode; triggerClassName?: string;
}) {
  const t = useTranslations("sprints");
  const [open, setOpen] = useState(false);
  const choose = (id: string | null) => {
    setOpen(false);
    if (id !== value) onChange(id);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClassName} aria-label={label} aria-haspopup="listbox">{children}</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`popover combobox-popover ${styles.pop}`} align="start" sideOffset={4}>
          <Command label={label}>
            <Command.Input aria-label={t("search")} placeholder={t("search")} />
            <Command.List aria-label={label}>
              <Command.Empty>{t("noMatch")}</Command.Empty>
              <Command.Item value={`— ${t("noSprint")}`} onSelect={() => choose(null)}>
                <SprintBadge sprint={null} />
                <span>{t("noSprint")}</span>
                {value === null && <Check size={16} aria-hidden="true" />}
              </Command.Item>
              {sprints.map((sprint) => (
                <Command.Item key={sprint.id} value={`${sprint.name} ${sprint.id}`} disabled={!openSprint(sprint)} onSelect={() => choose(sprint.id)}>
                  <SprintBadge sprint={sprint} />
                  <span className={styles.itemText}><span>{sprint.name}</span><span className={styles.meta}>{sprintMeta(sprint, year, t)}</span></span>
                  {value === sprint.id && <Check size={16} aria-hidden="true" />}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
          {onCreate && (
            <div className={styles.foot}>
              <button type="button" className={styles.add} onClick={() => { setOpen(false); onCreate(); }}><Plus size={14} aria-hidden="true" />{t("create")}</button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * ตัวกรองหลายตัวเลือก (Module / Sprint ในแท็บ Table) · ค่าเป็น id คั่นด้วย , ส่งต่อให้ API ตรง ๆ
 * options.group = หัวข้อย่อยในรายการ (เช่น "Sprint ทั้งหมด")
 */
export function MultiFilter({ label, allLabel, options, value, onChange, className }: {
  label: string; allLabel: string; value: string[]; onChange: (next: string[]) => void; className?: string;
  options: { id: string; name: string; meta?: string; badge?: ReactNode; swatch?: string | null; group?: string }[];
}) {
  const t = useTranslations("sprints");
  const chosen = options.filter((o) => value.includes(o.id));
  const text = !chosen.length ? allLabel : chosen.length === 1 ? chosen[0]!.name : t("filterMore", { name: chosen[0]!.name, count: chosen.length - 1 });
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={className} aria-label={`${label}: ${text}`}>{label}: <b className={styles.filterValue}>{text}</b></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`popover combobox-popover ${styles.pop}`} align="start" sideOffset={6}>
          <Command label={label}>
            <Command.Input aria-label={t("search")} placeholder={t("search")} />
            <Command.List aria-label={label}>
              <Command.Empty>{t("noMatch")}</Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g || "_"} heading={g || undefined}>
                  {options.filter((o) => (o.group ?? "") === g).map((o) => (
                    <Command.Item key={o.id} value={`${o.name} ${o.id}`} onSelect={() => toggle(o.id)} aria-checked={value.includes(o.id)} role="option">
                      <span className={`${styles.check} ${value.includes(o.id) ? styles.checked : ""}`} aria-hidden="true">{value.includes(o.id) && <Check size={11} strokeWidth={3} />}</span>
                      {o.swatch !== undefined && <span className={styles.swatch} style={o.swatch ? { background: o.swatch } : undefined} aria-hidden="true" />}
                      {o.badge}
                      <span className={styles.itemText}><span>{o.name}</span>{o.meta && <span className={styles.meta}>{o.meta}</span>}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
          <div className={styles.foot}>
            <span className={styles.meta}>{value.length ? t("chosen", { count: value.length }) : allLabel}</span>
            {value.length > 0 && <button type="button" className={styles.add} onClick={() => onChange([])}>{t("clear")}</button>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** ตัวเลือก Sprint สำหรับตัวกรอง: Sprint ปัจจุบัน + ยังไม่เข้า Sprint + ทุก Sprint */
export function sprintFilterOptions(sprints: Sprint[], year: YearFormat, t: ReturnType<typeof useTranslations>) {
  const active = sprints.find((s) => s.status === "active");
  return [
    { id: "current", name: t("current"), meta: active?.name ?? t("noActive") },
    { id: "none", name: t("noSprint") },
    ...sprints.map((s) => ({ id: s.id, name: s.name, meta: sprintMeta(s, year, t), badge: <SprintBadge sprint={s} />, group: t("allSprints") })),
  ];
}

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * สร้าง Sprint (ผู้ใช้ตัดสิน 2026-11-19): ผู้ใช้กำหนดวันเริ่มเอง และเลือกว่า Sprint ละกี่สัปดาห์
 * สร้างทีละหลายตัวได้ (ยังไม่มี Sprint = ค่าเริ่มต้น 9 ตัว) · สร้างตัวเดียวตั้งชื่อ / วันจบ / เป้าหมายเองได้
 */
export function CreateSprintDialog({ ws, projectKey, sprints, defaultWeeks, year, onClose, onCreated }: {
  ws: string; projectKey: string; sprints: Sprint[]; defaultWeeks?: number | null; year: YearFormat;
  onClose: () => void; onCreated: (created: Sprint[]) => void | Promise<void>;
}) {
  const t = useTranslations("sprints");
  const refresh = useRefreshSprints(ws, projectKey);
  const nextNumber = Math.max(0, ...sprints.map((s) => s.number)) + 1;
  // เก็บเป็นข้อความระหว่างพิมพ์ (ลบแล้วพิมพ์ใหม่ได้) · ใช้ค่าเป็นตัวเลขตอนคำนวณ
  const [countText, setCountText] = useState(String(sprints.length ? 1 : 9));
  const count = Number.parseInt(countText, 10) || 0;
  const [startDate, setStartDate] = useState(() => suggestedStart(sprints, todayIso()));
  const [weeks, setWeeks] = useState(defaultWeeks && defaultWeeks >= 1 && defaultWeeks <= 8 ? defaultWeeks : 2);
  const [name, setName] = useState(`Sprint ${nextNumber}`);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const series = useMemo(() => sprintSeries(startDate, weeks, Math.min(Math.max(count, 1), 26)), [startDate, weeks, count]);
  const single = count <= 1;
  // ตัวเดียว: วันจบตามจำนวนสัปดาห์ จนกว่าผู้ใช้จะแก้เอง
  const end = endDate ?? series[0]?.endDate ?? startDate;
  const invalid = !startDate || count < 1 || count > 26 || (single && (!name.trim() || end < startDate));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || pending) return;
    setPending(true); setError(null);
    try {
      const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}/sprints`;
      const created = single
        ? [await api.post<Sprint>(base, { name: name.trim(), startDate, endDate: end, goal: goal.trim() || null })]
        : (await createSprintSeries(ws, projectKey, { startDate, weeks, count })).items;
      await refresh();
      await onCreated(created);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally { setPending(false); }
  }
  return (
    <Dialog open title={t("createTitle")} description={t("createDescription")} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.row3}>
          <Input label={t("count")} type="number" min={1} max={26} required value={countText} onChange={(e) => setCountText(e.target.value)} error={countText && (count < 1 || count > 26) ? t("countRange") : undefined} />
          <Input label={t("startDate")} type="date" required value={startDate} onChange={(e) => { setStartDate(e.target.value); setEndDate(null); }} />
          <Select label={t("weeks")} value={String(weeks)} onChange={(e) => { setWeeks(Number(e.target.value)); setEndDate(null); }}>
            {WEEKS.map((w) => <option key={w} value={w}>{t("weeksOption", { count: w })}</option>)}
          </Select>
        </div>
        {single ? (
          <>
            <div className={styles.row2}>
              <Input label={t("name")} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
              <Input label={t("endDate")} type="date" required min={startDate} value={end} onChange={(e) => setEndDate(e.target.value)} error={end < startDate ? t("invalidRange") : undefined} />
            </div>
            <Input label={t("goal")} maxLength={10000} placeholder={t("goalPlaceholder")} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </>
        ) : (
          <div className={styles.preview} aria-label={t("preview")}>
            <div className={styles.previewHead}><span>{t("preview")}</span><span>{series.length ? `${formatDate(series[0]!.startDate, year)} – ${formatDate(series.at(-1)!.endDate, year)}` : ""}</span></div>
            <ol className={styles.previewList}>
              {series.map((s, i) => (
                <li key={s.startDate}><b>Sprint {nextNumber + i}</b><span>{formatDateRange(s.startDate, s.endDate, year)}</span></li>
              ))}
            </ol>
          </div>
        )}
        {error && <div className="field-error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <Button disabled={pending} onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={pending || invalid}>{single ? t("createOne") : t("createMany", { count })}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Dropdown Sprint ในหน้า Task / ฟอร์มสร้างงาน (ผู้ใช้ขอ 2026-11-19 · กลับมาหลังเอาออกเมื่อ 2026-11-08)
 * แบบเดียวกับช่องกลุ่ม: native select + "+ สร้าง Sprint ใหม่" เปิดหน้าต่างสร้าง แล้วเลือก Sprint แรกที่สร้างให้
 */
export function SprintSelect({ ws, projectKey, label, value, year, disabled, canCreate, onChange }: {
  ws: string; projectKey: string; label: string; value: string | null; year: YearFormat; disabled?: boolean; canCreate?: boolean; onChange: (id: string | null) => void;
}) {
  const t = useTranslations("sprints");
  const sprints = useSprints(ws, projectKey);
  const [creating, setCreating] = useState(false);
  const items = sprints.data?.items ?? [];
  return <>
    <Select label={label} value={value ?? ""} disabled={disabled || sprints.isPending} onChange={(event) => {
      if (event.target.value === "__new") { setCreating(true); return; }
      onChange(event.target.value || null);
    }}>
      <option value="">{t("noSprint")}</option>
      {items.map((s) => (
        <option key={s.id} value={s.id} disabled={!openSprint(s) && s.id !== value}>
          {s.name} · {formatDateRange(s.startDate, s.endDate, year)}{s.status === "planning" ? "" : ` · ${t(`status.${s.status}`)}`}
        </option>
      ))}
      {canCreate && <option value="__new">+ {t("create")}</option>}
    </Select>
    {creating && <CreateSprintDialog ws={ws} projectKey={projectKey} sprints={items} defaultWeeks={sprints.data?.sprintLengthWeeks} year={year} onClose={() => setCreating(false)}
      onCreated={(created) => { setCreating(false); if (created[0]) onChange(created[0].id); }} />}
  </>;
}
