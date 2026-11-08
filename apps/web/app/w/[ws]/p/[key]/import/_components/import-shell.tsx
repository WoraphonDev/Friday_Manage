"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "../../../../import/_components/import.module.css";

export type ImportSection = "import" | "export";

/**
 * Import / Export ของโปรเจกต์ (ผู้ใช้ตัดสิน 2026-11-09: อยู่ใต้โปรเจกต์ ไม่ใช่หน้ากลาง)
 * เมนูด้านซ้าย + เนื้อหาด้านขวาแบบหน้า Report · อยู่ใน ProjectShell จึงเห็นแท็บของโปรเจกต์เสมอ
 * "การแก้ไขแผน" ไม่อยู่ในเมนูนี้: เป็นแท็บของตัวเอง ติดตามการเปลี่ยนแผนเทียบ Baseline จากทุกช่องทาง ไม่ใช่เฉพาะ Excel (ผู้ใช้ 2026-11-09)
 */
export function ImportShell({ ws, projectKey, active, children }: { ws: string; projectKey: string; active: ImportSection; children: ReactNode }) {
  const t = useTranslations("import-plan-changes.import");
  const p = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}`;
  const items: [ImportSection, string][] = [
    ["import", `${p}/import`],
    ["export", `${p}/import?section=export`],
  ];
  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <nav className={`${styles.card} ${styles.sideNav}`} aria-label={t("sections")}>
          {items.map(([key, href]) => (
            <Link key={key} href={href} scroll={false} className={`${styles.navItem} ${active === key ? styles.navOn : ""}`} aria-current={active === key ? "page" : undefined}>
              {t(`section__${key}`)}
            </Link>
          ))}
          <p className={styles.navNote}>{t("sectionNote")}</p>
        </nav>
        <div className={styles.main}>{children}</div>
      </div>
    </div>
  );
}
