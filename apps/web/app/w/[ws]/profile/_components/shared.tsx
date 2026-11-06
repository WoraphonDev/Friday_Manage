"use client";

import { ErrorState, Forbidden } from "@/components/ui";
import { ApiError } from "@/lib/api";
import styles from "./profile.module.css";

export const wsPath = (ws: string) => `/w/${encodeURIComponent(ws)}`;
export const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Error ของแต่ละส่วน: 403 = ไม่มีสิทธิ์ · อื่น ๆ แสดงพร้อม requestId */
export function SectionError({ error, retry }: { error: unknown; retry: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <Forbidden />;
  return <ErrorState error={error} retry={retry} />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className={styles.switch} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export async function copyText(text: string) {
  await navigator.clipboard?.writeText(text);
}
