"use client";

import { useTranslations } from "next-intl";
import { Pill } from "@/components/ui";
import { planLabel, useFmt } from "../../workspaces/_parts/format";
import styles from "../changelog.module.css";
import { type Entry, KIND_TONE } from "./types";

const TEAM_UP = ["team_s", "team_m", "team_l", "enterprise"];

/** "ใครเห็น" ในตาราง: ทุกแพ็กเกจ · Team ขึ้นไป / รายชื่อแพ็กเกจ · Workspace ที่เปิด flag (n) · Owner และ Admin */
export function useAudienceLabel() {
  const t = useTranslations("cl.audience");
  return (e: Pick<Entry, "audience" | "audiencePlans" | "flagWorkspaces">) => {
    if (e.audience === "plans") return TEAM_UP.every((p) => e.audiencePlans.includes(p)) && !e.audiencePlans.includes("free") ? t("teamUp") : e.audiencePlans.map(planLabel).join(", ");
    if (e.audience === "flag") return t("flag", { count: e.flagWorkspaces ?? 0 });
    return t(e.audience);
  };
}

export function useStatusLabel() {
  const t = useTranslations("cl.status");
  const fmt = useFmt();
  return (e: Pick<Entry, "status" | "publishedAt">) => (e.status === "scheduled" ? t("scheduled", { at: fmt.dateTime(e.publishedAt) }) : t(e.status));
}

/** การ์ดหนึ่งรายการในแผง "มีอะไรใหม่" ของลูกค้า (U1) ใช้ในตัวอย่างข้างตารางและปุ่ม "ดูตัวอย่าง" ของ U4 */
export function PanelPreview({ entry }: { entry: Pick<Entry, "kind" | "title" | "summary" | "mediaUrl" | "mediaKind" | "mediaAlt" | "ctaLabel" | "displayDate" | "publishedAt"> }) {
  const t = useTranslations("cl");
  const fmt = useFmt();
  return (
    <div className={styles.pv}>
      <div className={styles.pvHead}>{t("preview.panel")}</div>
      <div className={styles.pvBody}>
        <span className="row">
          <Pill tone={KIND_TONE[entry.kind]}>{t(`kind.${entry.kind}`)}</Pill>
          <span className="muted small">{fmt.date(entry.displayDate ?? entry.publishedAt ?? new Date().toISOString())}</span>
        </span>
        {entry.mediaUrl &&
          (entry.mediaKind === "video" ? (
            <video className={styles.pvMedia} src={entry.mediaUrl} muted aria-label={entry.mediaAlt ?? ""} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- รูปจากที่เก็บไฟล์สาธารณะภายนอก ไม่ผ่าน next/image
            <img className={styles.pvMedia} src={entry.mediaUrl} alt={entry.mediaAlt ?? ""} />
          ))}
        <b className={styles.pvTitle}>{entry.title || "—"}</b>
        <span className="muted small">{entry.summary}</span>
        {entry.ctaLabel && (
          <span>
            <span className="button button-small">{entry.ctaLabel}</span>
          </span>
        )}
      </div>
    </div>
  );
}
