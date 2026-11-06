"use client";

import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { adminKey, errorText, wsPath, type WorkspaceSettings } from "./types";
import styles from "./admin.module.css";

export function Card({ title, actions, children, label }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className={styles.card} aria-label={label}>
      {(title || actions) && (
        <div className={styles.ch}>
          {title && <h2>{title}</h2>}
          {actions && <div className={styles.chips}>{actions}</div>}
        </div>
      )}
      <div className={styles.cb}>{children}</div>
    </section>
  );
}

export function Switch({ checked, label, onChange, disabled }: { checked: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className={styles.switch} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** ตัวเลือกแบบปุ่มกด (radio) ตาม .opt ใน Canvas */
export function OptionGroup<T extends string | number | null>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; title: string; description?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className={styles.opts} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={styles.opt} disabled={disabled} onClick={() => onChange(o.value)}>
          <span>
            <b>{o.title}</b>
            {o.description && <div className={styles.muted}>{o.description}</div>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Closed({ title, description }: { title: string; description: string }) {
  return (
    <div className={styles.closed} role="status">
      <b>{title}</b>
      <span className={styles.muted}>{description}</span>
    </div>
  );
}

/** PATCH ของ Admin Console (A18, A25, A28) ไม่ใช้ If-Match */
export const patch = <T,>(path: string, body: unknown) => api.request<T>(path, { method: "PATCH", body });

/** w/settings ใช้หลายแท็บ (ค่ามาตรฐาน, ข้อมูล, ช่องทางแจ้งเตือน) · cache เดียวกัน */
export function useSettings(ws: string) {
  return useQuery({ queryKey: adminKey(ws, "settings"), queryFn: () => api.get<WorkspaceSettings>(`${wsPath(ws)}/settings`) });
}

/** PATCH w/settings ทีละส่วน · ตอบค่าล่าสุดทั้งชุด จึงเขียนทับ cache ได้เลย */
export function usePatchSettings(ws: string) {
  const cache = useQueryClient();
  const toast = useToast();
  const t = useTranslations("admin-automation.admin");
  return async (body: Partial<WorkspaceSettings>, message = t("saved")) => {
    try {
      // w/settings ไม่มี version (A18) จึงไม่ส่ง If-Match
      const next = await patch<WorkspaceSettings>(`${wsPath(ws)}/settings`, body);
      cache.setQueryData(adminKey(ws, "settings"), next);
      const issues = next.recalculated?.issues ?? 0;
      toast({ message: issues ? t("recalculated", { issues, projects: next.recalculated?.projects ?? 0 }) : message });
      return true;
    } catch (e) {
      toast({ message: errorText(e, t("failed")) });
      return false;
    }
  };
}
