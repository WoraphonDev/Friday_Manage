import type { ReactNode } from "react";
import styles from "./settings.module.css";

export const projectEndpoint = (ws: string, key: string) => `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(key)}`;
export const membersKey = (ws: string, key: string) => ["workspace", ws, "project", key, "members"] as const;

export function SectionHead({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className={styles.sh}>
      <div>
        <h2 id="settings-heading">{title}</h2>
        <div className={styles.muted}>{description}</div>
      </div>
      {children}
    </div>
  );
}
