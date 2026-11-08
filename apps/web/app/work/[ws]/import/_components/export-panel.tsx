"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { LoadingState } from "@/components/ui";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query";
import type { Permissions } from "@/lib/types";
import styles from "./import.module.css";

const SHEETS = ["tasks", "timeline", "values", "guide", "holidays"] as const;

/**
 * Export แผน ณ ปัจจุบัน + Timeline (ผู้ใช้ขอ 2026-11-09)
 * คอลัมน์เดียวกับ Template จึงเอาไปทำงานข้างนอกแล้วนำเข้ากลับ (อัปเดตโปรเจกต์เดิม) ได้
 */
export function ExportPanel({ ws, projectKey: key }: { ws: string; projectKey: string }) {
  const t = useTranslations("import-plan-changes.export");
  const w = `/w/${encodeURIComponent(ws)}`;
  const [scale, setScale] = useState<"day" | "week">("day");
  const perms = useQuery({
    queryKey: queryKeys.permissions(ws, key),
    queryFn: () => api.get<Permissions>(`${w}/projects/${encodeURIComponent(key)}/my-permissions`),
  });
  const allowed = perms.isSuccess && !perms.data.guestViewer && perms.data.permissions.includes("project.view");
  const href = `/api/v1${w}/projects/${encodeURIComponent(key)}/export.xlsx${scale === "week" ? "?timeline=week" : ""}`;

  return (
    <section className={`${styles.card} ${styles.pad}`} aria-label={t("title")}>
      <div>
        <h2 className={styles.sectionTitle}>{t("title")}</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>{t("description")}</p>
      </div>
      {perms.isPending ? <LoadingState /> : (
        <div className="field">
          <span>{t("scale")}</span>
          <div className={styles.seg} role="radiogroup" aria-label={t("scale")}>
            {(["day", "week"] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={scale === s} onClick={() => setScale(s)}>{t(`scale__${s}`)}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        <b className={styles.small}>{t("sheets")}</b>
        <ul className={styles.sheetList}>
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
