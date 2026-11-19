"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import { useSlidingIndicator } from "@/lib/motion";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import { Select } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { formatDateRange } from "@/lib/format";
import { useSprints } from "@/features/sprints/sprints";
import type { TableFilters } from "@/features/plan-io/plan-io";
import styles from "./import.module.css";

const SHEETS = ["tasks", "timeline", "values", "guide", "holidays"] as const;

/**
 * Export แผน ณ ปัจจุบัน + Timeline (ผู้ใช้ขอ 2026-11-09)
 * คอลัมน์เดียวกับ Template จึงเอาไปทำงานข้างนอกแล้วนำเข้ากลับ (อัปเดตโปรเจกต์เดิม) ได้
 */
export function ExportPanel({ ws, projectKey: key, tableFilters = null }: { ws: string; projectKey: string; tableFilters?: TableFilters }) {
  const t = useTranslations("import-plan-changes.export");
  const w = `/w/${encodeURIComponent(ws)}`;
  const { me } = useWorkspace();
  const [scale, setScale] = useState<"day" | "week">("day");
  // Day / Week เลือกได้ทีละอัน พื้นม่วงอ่อนเลื่อนตามตัวที่เลือก
  const segRef = useSlidingIndicator<HTMLDivElement>("button");
  const scopeRef = useSlidingIndicator<HTMLDivElement>("button");
  // ขอบเขต (ผู้ใช้ขอ 2026-11-19): ทั้งโปรเจกต์ / เลือก Sprint / ตามตัวกรองในตาราง
  // ตารางกรอง Sprint เดียวอยู่ = เลือก Sprint นั้นไว้ให้ · กรองอย่างอื่นอยู่ = ตามตัวกรอง
  const fromTable = new URLSearchParams(tableFilters?.query ?? "");
  const tableSprint = fromTable.size === 1 && fromTable.get("sprint") && !fromTable.get("sprint")!.includes(",") ? fromTable.get("sprint")! : null;
  const [scope, setScope] = useState<"all" | "sprint" | "filters">(tableSprint ? "sprint" : tableFilters ? "filters" : "all");
  const [sprint, setSprint] = useState(tableSprint ?? "current");
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, key),
    queryFn: () => api.get<Permissions>(`${w}/projects/${encodeURIComponent(key)}/my-permissions`),
  });
  const allowed = perms.isSuccess && !perms.data.guestViewer && perms.data.permissions.includes("project.view");
  const sprints = useSprints(ws, key, allowed);
  const query = new URLSearchParams(scope === "filters" && tableFilters ? tableFilters.query : scope === "sprint" ? { sprint } : {});
  if (scale === "week") query.set("timeline", "week");
  const href = `/api/v1${w}/projects/${encodeURIComponent(key)}/export.xlsx${query.size ? `?${query}` : ""}`;
  const sprintName = sprint === "current" ? t("scopeCurrent") : sprint === "none" ? t("scopeNoSprint") : (sprints.data?.items.find((x) => x.id === sprint)?.name ?? "");
  const scopes = (["all", "sprint", ...(tableFilters ? ["filters"] as const : [])] as const);

  return (
    <section className={`${styles.card} ${styles.pad}`} aria-label={t("title")}>
      <div>
        <h2 className={styles.sectionTitle}>{t("title")}</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>{t("description")}</p>
      </div>
      {perms.isPending ? <LoadingState /> : (<>
        <div className="field">
          <span>{t("scope")}</span>
          <div ref={scopeRef} className={`${styles.seg} motion-pill`} role="radiogroup" aria-label={t("scope")}>
            {scopes.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>{s === "filters" ? t("scope__filters", { count: tableFilters?.count ?? 0 }) : t(`scope__${s}`)}</button>
            ))}
          </div>
        </div>
        {scope === "sprint" && (
          <div style={{ maxWidth: 420 }}>
            <Select label="Sprint" value={sprint} onChange={(e) => setSprint(e.target.value)}>
              <option value="current">{t("scopeCurrent")}</option>
              {(sprints.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {formatDateRange(x.startDate, x.endDate, me.yearFormat)}</option>)}
              <option value="none">{t("scopeNoSprint")}</option>
            </Select>
          </div>
        )}
        {scope !== "all" && <p className={styles.scopeNote} role="note">{t("partialNote", { scope: scope === "sprint" ? sprintName : t("scopeFiltered") })}</p>}
        <div className="field">
          <span>{t("scale")}</span>
          <div ref={segRef} className={`${styles.seg} motion-pill`} role="radiogroup" aria-label={t("scale")}>
            {(["day", "week"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scale === s} onClick={() => setScale(s)}>{t(`scale__${s}`)}</button>
            ))}
          </div>
        </div>
      </>)}
      <div>
        <b className={styles.small}>{t("sheets")}</b>
        <ul className={`${styles.sheetList} motion-list`}>
          {SHEETS.map((s) => <li key={s}><b>{t(`sheet__${s}`)}</b><span className="muted">{t(`sheetHint__${s}`)}</span></li>)}
        </ul>
      </div>
      <div className={styles.exportActions}>
        <a className="button" href={`/api/v1${w}/import-template.xlsx`} download>{t("template")}</a>
        {allowed
          ? <a className="button button-primary" href={href} download><Download size={16} aria-hidden="true" /> {t("download")}</a>
          : <span className="button button-primary" aria-disabled="true" style={{ opacity: 0.5, pointerEvents: "none" }}><Download size={16} aria-hidden="true" /> {t("download")}</span>}
      </div>
      {perms.isSuccess && !allowed && <p className="field-error">{t("noPermission")}</p>}
    </section>
  );
}
