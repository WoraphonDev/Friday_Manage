"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ImportWizard } from "../../import/_components/import-wizard";
import styles from "../../import/_components/import.module.css";

/**
 * สร้างโปรเจกต์ใหม่จากไฟล์ Excel · ทางเข้าอยู่ที่หน้า New project
 * (ผู้ใช้ตัดสิน 2026-11-09: Import / Export อยู่ใต้โปรเจกต์ ส่วนการสร้างโปรเจกต์จาก Excel ย้ายมาอยู่กับ New project)
 */
export function CreateFromExcel({ ws }: { ws: string }) {
  const t = useTranslations("import-plan-changes.create");
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={`muted ${styles.crumb}`}>{t("crumb")}</div>
          <h1>{t("title")}</h1>
          <div className="muted">{t("description")}</div>
        </div>
        <div className={styles.actions}>
          <Link className="button" href={`/work/${encodeURIComponent(ws)}/new-project`}>{t("back")}</Link>
        </div>
      </div>
      <ImportWizard ws={ws} />
    </div>
  );
}
