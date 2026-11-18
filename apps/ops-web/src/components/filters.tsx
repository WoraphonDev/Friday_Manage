"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Chip, Popover } from "./kit";
import { Button, Input } from "./ui";

/**
 * แผงตัวกรองกลางของ Friday Ops (ช่วง 3) · ทุกหน้าใช้แบบเดียวกัน
 * หัวข้อเดียวกันเลือกหลายค่า = "หรือ" · ต่างหัวข้อ = ต้องตรงทุกข้อ · ค่าเก็บเป็นข้อความใน URL (หลายค่าคั่นด้วยจุลภาค)
 */
export interface FilterOption {
  value: string;
  label: string;
}
export type FilterDef =
  | { key: string; label: string; kind: "multi" | "single"; options: FilterOption[] }
  /** ช่วงตัวเลข · baht = ผู้ใช้กรอกบาท ส่งเป็นสตางค์ */
  | { key: string; label: string; kind: "range"; minKey: string; maxKey: string; unit?: "baht" }
  /** ค่าลัด (presetKey) หรือช่วงวันที่ (fromKey / toKey) */
  | { key: string; label: string; kind: "dates"; presetKey?: string; presets?: FilterOption[]; fromKey: string; toKey: string }
  | { key: string; label: string; kind: "text"; placeholder?: string };
export type FilterValues = Record<string, string>;

const keysOf = (d: FilterDef) => (d.kind === "range" ? [d.minKey, d.maxKey] : d.kind === "dates" ? [...(d.presetKey ? [d.presetKey] : []), d.fromKey, d.toKey] : [d.key]);
const split = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);
const baht = (satang: string) => String(Math.round(Number(satang) / 100));
const satang = (b: string) => (b.trim() === "" ? "" : String(Math.round(Number(b) * 100)));

/** จำนวนหัวข้อที่ใช้อยู่ */
export const activeCount = (defs: FilterDef[], v: FilterValues) => defs.filter((d) => keysOf(d).some((k) => !!v[k])).length;

/** ข้อความของค่าที่เลือก (ชิปเหนือตาราง) */
function valueText(d: FilterDef, v: FilterValues, t: (k: string, p?: Record<string, string>) => string) {
  if (d.kind === "multi" || d.kind === "single") return split(v[d.key]).map((x) => d.options.find((o) => o.value === x)?.label ?? x).join(", ");
  if (d.kind === "text") return v[d.key];
  if (d.kind === "range") {
    const show = (x: string) => (d.unit === "baht" ? `฿${Number(baht(x)).toLocaleString("en-US")}` : x);
    const [a, b] = [v[d.minKey], v[d.maxKey]];
    return a && b ? `${show(a)}–${show(b)}` : a ? t("atLeast", { n: show(a) }) : t("atMost", { n: show(b) });
  }
  if (d.kind !== "dates") return "";
  const preset = d.presetKey && v[d.presetKey] ? d.presets?.find((o) => o.value === v[d.presetKey!])?.label : null;
  return preset ?? [v[d.fromKey], v[d.toKey]].map((x) => x || "…").join(" – ");
}

export function FilterButton({ defs, values, onChange }: { defs: FilterDef[]; values: FilterValues; onChange: (patch: FilterValues) => void }) {
  const t = useTranslations("common.filters");
  const n = activeCount(defs, values);
  const toggle = (d: Extract<FilterDef, { kind: "multi" | "single" }>, value: string) => {
    const cur = split(values[d.key]);
    const next = d.kind === "single" ? (cur[0] === value ? [] : [value]) : cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    onChange({ [d.key]: next.join(",") });
  };
  return (
    <Popover
      label={t("title")}
      trigger={({ toggle: open, open: isOpen }) => (
        <Button aria-expanded={isOpen} onClick={open}>
          <SlidersHorizontal size={14} aria-hidden="true" /> {n ? t("buttonOn", { n }) : t("button")}
        </Button>
      )}
    >
      {() => (
        <div className="filter-panel">
          {defs.map((d) => (
            <section key={d.key} className="filter-group" aria-label={d.label}>
              <span className="filter-label">{d.label}</span>
              {(d.kind === "multi" || d.kind === "single") && (
                <div className="row" role="group" aria-label={d.label}>
                  {d.options.map((o) => (
                    <Chip key={o.value} pressed={split(values[d.key]).includes(o.value)} onClick={() => toggle(d, o.value)}>
                      {o.label}
                    </Chip>
                  ))}
                </div>
              )}
              {d.kind === "text" && <Input aria-label={d.label} placeholder={d.placeholder} value={values[d.key] ?? ""} onChange={(e) => onChange({ [d.key]: e.target.value })} />}
              {d.kind === "range" && (
                <div className="row">
                  <Input aria-label={`${d.label} ${t("min")}`} placeholder={t("min")} inputMode="numeric" value={values[d.minKey] ? (d.unit === "baht" ? baht(values[d.minKey]) : values[d.minKey]) : ""} onChange={(e) => onChange({ [d.minKey]: d.unit === "baht" ? satang(e.target.value) : e.target.value })} />
                  <span className="muted">–</span>
                  <Input aria-label={`${d.label} ${t("max")}`} placeholder={t("max")} inputMode="numeric" value={values[d.maxKey] ? (d.unit === "baht" ? baht(values[d.maxKey]) : values[d.maxKey]) : ""} onChange={(e) => onChange({ [d.maxKey]: d.unit === "baht" ? satang(e.target.value) : e.target.value })} />
                </div>
              )}
              {d.kind === "dates" && (
                <div className="stack" style={{ gap: 6 }}>
                  {d.presets && d.presetKey && (
                    <div className="row" role="group" aria-label={d.label}>
                      {d.presets.map((o) => (
                        <Chip key={o.value} pressed={values[d.presetKey!] === o.value} onClick={() => onChange({ [d.presetKey!]: values[d.presetKey!] === o.value ? "" : o.value, [d.fromKey]: "", [d.toKey]: "" })}>
                          {o.label}
                        </Chip>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <Input type="date" aria-label={`${d.label} ${t("from")}`} value={values[d.fromKey] ?? ""} onChange={(e) => onChange({ [d.fromKey]: e.target.value, ...(d.presetKey ? { [d.presetKey]: "" } : {}) })} />
                    <span className="muted">–</span>
                    <Input type="date" aria-label={`${d.label} ${t("to")}`} value={values[d.toKey] ?? ""} onChange={(e) => onChange({ [d.toKey]: e.target.value, ...(d.presetKey ? { [d.presetKey]: "" } : {}) })} />
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** ชิปตัวกรองที่ใช้อยู่เหนือตาราง · ✕ เอาออกทีละหัวข้อ · ล้างทั้งหมด */
export function ActiveFilters({ defs, values, onChange }: { defs: FilterDef[]; values: FilterValues; onChange: (patch: FilterValues) => void }) {
  const t = useTranslations("common.filters");
  const on = defs.filter((d) => keysOf(d).some((k) => !!values[k]));
  if (!on.length) return null;
  const clear = (d: FilterDef) => Object.fromEntries(keysOf(d).map((k) => [k, ""]));
  return (
    <div className="row active-filters">
      {on.map((d) => (
        <span key={d.key} className="filter-chip">
          {d.label}: {valueText(d, values, t)}
          <button type="button" className="link-button" aria-label={t("remove", { name: d.label })} onClick={() => onChange(clear(d))}>
            <X size={12} />
          </button>
        </span>
      ))}
      {on.length > 1 && (
        <button type="button" className="link-button small" onClick={() => onChange(Object.assign({}, ...on.map(clear)))}>
          {t("clearAll")}
        </button>
      )}
    </div>
  );
}

/** คีย์ทั้งหมดของชุดตัวกรอง (ใช้ตั้งค่าเริ่มต้นของ useUrlFilters) */
export const filterKeys = (defs: FilterDef[]) => Object.fromEntries(defs.flatMap(keysOf).map((k) => [k, ""])) as FilterValues;
/** เฉพาะค่าที่ใช้ (ส่งไป ops-api) */
export const filterQuery = (defs: FilterDef[], v: FilterValues) => Object.fromEntries(defs.flatMap(keysOf).filter((k) => v[k]).map((k) => [k, v[k]]));
