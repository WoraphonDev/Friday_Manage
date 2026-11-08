"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "./import.module.css";

/**
 * หัวหน้า L3 ที่ใช้ร่วมกันระหว่าง `/import` และ `/p/:key/plan-changes`
 * Canvas วางสองส่วนเป็นแท็บในหน้าเดียว · ในเว็บแยกเส้นทางตาม lane จึงทำแท็บเป็นลิงก์
 * แท็บการแก้ไขแผนแสดงเมื่อรู้โปรเจกต์ (ต้องมีโปรเจกต์ถึงจะมี Baseline)
 */
export function ImportHeader({
  ws,
  projectKey,
  projectName,
  active,
  canExport,
  canChanges,
  compact,
  hideTabs,
}: {
  ws: string;
  projectKey?: string;
  projectName?: string;
  active: "import" | "changes";
  canExport?: boolean;
  canChanges?: boolean;
  /** อยู่ใต้ project shell ซึ่งมีหัวโปรเจกต์แล้ว · แสดงแค่แท็บ */
  compact?: boolean;
  /** หน้านำเข้า / Export ใช้เมนูด้านซ้ายแทนแท็บ (แบบหน้า Report) */
  hideTabs?: boolean;
}) {
  const t = useTranslations("import-plan-changes.header");
  const w = `/w/${encodeURIComponent(ws)}`;
  const p = projectKey ? `${w}/p/${encodeURIComponent(projectKey)}` : null;
  const importHref = `${w}/import${projectKey ? `?project=${encodeURIComponent(projectKey)}` : ""}`;
  return (
    <>
      {!compact && (
        <div className={styles.head}>
          <div>
            <div className={`muted ${styles.crumb}`}>{projectName ? t("crumb", { project: projectName }) : t("crumbNone")}</div>
            <h1>{t("title")}</h1>
            <div className="muted">{t("description")}</div>
          </div>
          {p && (
            <div className={styles.actions}>
              {canExport && (
                <a className="button" href={`/api/v1${w}/projects/${encodeURIComponent(projectKey!)}/export.xlsx`} download>
                  {t("export")}
                </a>
              )}
              <Link className="button" href={`${p}/table`}>{t("backToTable")}</Link>
            </div>
          )}
        </div>
      )}
      {!hideTabs && <nav className={styles.tabs} aria-label={t("sections")}>
        <Link className={styles.ttab} href={importHref} aria-current={active === "import" ? "page" : undefined}>{t("tabImport")}</Link>
        {p && canChanges && (
          <Link className={styles.ttab} href={`${p}/plan-changes`} aria-current={active === "changes" ? "page" : undefined}>{t("tabChanges")}</Link>
        )}
      </nav>}
    </>
  );
}
