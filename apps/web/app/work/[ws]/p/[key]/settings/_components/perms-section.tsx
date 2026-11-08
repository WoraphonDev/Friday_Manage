"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { projectEndpoint, SectionHead } from "./shared";
import { errorText } from "./types";
import styles from "./settings.module.css";

/**
 * 10 แถวของ L2 › สิทธิ์ของแต่ละ Role · ค่า = [Member, Viewer] ตามค่าเริ่มต้นของ API (projects/permissions.ts › L2_PERMISSIONS)
 * แถวที่คุม 2 สิทธิ์ (สร้าง/แก้งาน, อัปโหลด/ลบไฟล์) ส่งชื่อแรก API เปิดปิดทั้งคู่ให้
 */
export const PERMISSION_ROWS = [
  ["project.view", true, true],
  ["issue.comment", true, true],
  ["issue.create", true, false],
  ["issue.delete", false, false],
  ["issue.change_due_directly", false, false],
  ["due_request.approve", false, false],
  ["file.upload", true, false],
  ["sprint.manage", false, false],
  ["project.invite", false, false],
  ["project.settings", false, false],
] as const;
type Role = "member" | "viewer";
const ROLES: Role[] = ["member", "viewer"];
const cell = (permission: string, role: Role) => `${permission}:${role}`;

export function PermsSection({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("project-settings-new.settings.perms");
  const toast = useToast();
  // API ยังไม่มี GET p/role-permissions จึงเริ่มจากค่าเริ่มต้น แล้วจำค่าที่เปลี่ยนในหน้านี้ (คำขอนอก lane ถึง A04)
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PERMISSION_ROWS.flatMap(([p, member, viewer]) => [[cell(p, "member"), member], [cell(p, "viewer"), viewer]])),
  );
  const [pending, setPending] = useState<string | null>(null);

  async function toggle(permission: string, role: Role, allowed: boolean) {
    const id = cell(permission, role);
    setValues((v) => ({ ...v, [id]: allowed }));
    setPending(id);
    try {
      await api.put(`${projectEndpoint(ws, projectKey)}/role-permissions`, { role, permission, allowed });
      toast({ message: t("saved", { name: t(`rows.${permission.replace(".", "__")}`), role: t(`roles.${role}`) }) });
    } catch (e) {
      setValues((v) => ({ ...v, [id]: !allowed }));
      toast({ message: errorText(e, t("failed")) });
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <SectionHead title={t("title")} description={t("description")} />
      <div className={styles.mxWrap}>
        <div role="table" aria-label={t("title")} style={{ minWidth: 490 }}>
          <div role="row" className={`${styles.mx} ${styles.mxHead}`}>
            <div role="columnheader">{t("can")}</div>
            <div role="columnheader">{t("roles.admin")}</div>
            <div role="columnheader">{t("roles.member")}</div>
            <div role="columnheader">{t("roles.viewer")}</div>
          </div>
          {PERMISSION_ROWS.map(([permission]) => {
            const name = t(`rows.${permission.replace(".", "__")}`);
            return (
              <div role="row" key={permission} className={styles.mx}>
                <div role="cell">{name}</div>
                <input type="checkbox" checked disabled aria-label={t("cellAria", { name, role: t("roles.admin") })} />
                {ROLES.map((role) => (
                  <input
                    key={role}
                    type="checkbox"
                    checked={values[cell(permission, role)]}
                    disabled={pending === cell(permission, role)}
                    aria-label={t("cellAria", { name, role: t(`roles.${role}`) })}
                    onChange={(e) => void toggle(permission, role, e.target.checked)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className={styles.sb}>
        <div className={styles.muted}>{t("hint")}</div>
        <div className={styles.note} role="note">{t("defaultsNote")}</div>
      </div>
    </>
  );
}
