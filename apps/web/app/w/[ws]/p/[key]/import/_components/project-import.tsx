"use client";

import { useSearchParams } from "next/navigation";
import { ExportPanel } from "../../../../import/_components/export-panel";
import { ImportWizard } from "../../../../import/_components/import-wizard";
import { ImportShell } from "./import-shell";

/** /p/{key}/import · อัปเดตแผนจาก Excel หรือ Export แผน + Timeline ของโปรเจกต์นี้ */
export function ProjectImport({ ws, projectKey }: { ws: string; projectKey: string }) {
  const section = useSearchParams().get("section") === "export" ? "export" : "import";
  return (
    <ImportShell ws={ws} projectKey={projectKey} active={section}>
      {section === "export" ? <ExportPanel ws={ws} projectKey={projectKey} /> : <ImportWizard ws={ws} projectKey={projectKey} />}
    </ImportShell>
  );
}
