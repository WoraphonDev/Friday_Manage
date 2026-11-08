"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export type StructureAction =
  | { kind: "createModule" }
  | { kind: "renameModule"; id: string; name: string }
  | { kind: "createPhase"; moduleId: string; moduleName: string }
  | { kind: "renamePhase"; moduleId: string; id: string; name: string }
  | { kind: "deletePhase"; moduleId: string; id: string; name: string };

/** การจัดโครงงานต้องทำต่อจาก Table ได้ โดยไม่เสียตำแหน่งไปหน้า Settings */
export function StructureDialog({ base, action, onClose, onSaved }: {
  base: string; action: StructureAction; onClose: () => void;
  onSaved: (moduleId: string, phaseId?: string) => Promise<void>;
}) {
  const t = useTranslations("overview-table.table.structure");
  const [name, setName] = useState("name" in action ? action.name : "");
  const [color, setColor] = useState("#1d4ed8");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const phase = action.kind === "createPhase" || action.kind === "renamePhase" || action.kind === "deletePhase";
  const removing = action.kind === "deletePhase";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim()) return;
    lock.current = true; setPending(true); setError(null);
    try {
      if (action.kind === "deletePhase") {
        // ลบกลุ่ม: Task (และ Sub-task) ในกลุ่มกลับไปอยู่ใต้ Module โดยไม่มีกลุ่ม
        await api.request(`${base}/modules/${action.moduleId}/phases/${action.id}`, { method: "DELETE", body: { moveTo: "none" } });
        await onSaved(action.moduleId);
        onClose();
        return;
      }
      const collection = phase ? `${base}/modules/${action.moduleId}/phases` : `${base}/modules`;
      const body = { name: name.trim(), ...(action.kind === "createModule" ? { color } : {}) };
      const row = action.kind === "renameModule" || action.kind === "renamePhase"
        ? await api.request<{ id: string }>(`${collection}/${action.id}`, { method: "PATCH", body })
        : await api.post<{ id: string }>(collection, body);
      await onSaved(phase ? action.moduleId : row.id, phase ? row.id : undefined);
      onClose();
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }

  return <Dialog open title={t(action.kind)} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      {action.kind === "createPhase" && <p className="muted">{action.moduleName}</p>}
      {removing ? <p>{t("deletePhaseBody", { name: action.name })}</p>
        : <Input label={t(phase ? "phaseName" : "moduleName")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus disabled={pending} />}
      {action.kind === "createModule" && <label style={{ display: "flex", alignItems: "center", gap: 12 }}>{t("color")}<input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={pending} /></label>}
      {error != null && <p role="alert" className="field-error">{error instanceof Error ? error.message : t("failed")}{error instanceof ApiError && error.requestId ? ` · ${error.requestId}` : ""}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" disabled={pending} onClick={onClose}>{t("cancel")}</Button>
        <Button type="submit" variant={removing ? "danger" : "primary"} disabled={pending || !name.trim()} aria-busy={pending}>{t(removing ? "deletePhase" : action.kind.startsWith("create") ? "create" : "save")}</Button>
      </div>
    </form>
  </Dialog>;
}
