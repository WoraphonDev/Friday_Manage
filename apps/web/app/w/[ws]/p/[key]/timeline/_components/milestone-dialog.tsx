"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Dialog, Input, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export function MilestoneDialog({ base, initialDate, modules, onClose, onCreated }: {
  base: string; initialDate: string; modules: { id: string; name: string }[];
  onClose: () => void; onCreated: () => Promise<void>;
}) {
  const t = useTranslations("timeline.milestoneForm");
  const [name, setName] = useState("");
  const [date, setDate] = useState(initialDate);
  const [moduleId, setModuleId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim() || !date) return;
    lock.current = true; setPending(true); setError(null);
    try {
      await api.post(`${base}/milestones`, { name: name.trim(), date, moduleId: moduleId || null });
      await onCreated(); onClose();
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setPending(false); }
  }
  return <Dialog open title={t("title")} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      <Input label={t("name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus disabled={pending} />
      <Input type="date" label={t("date")} value={date} onChange={(e) => setDate(e.target.value)} required disabled={pending} />
      <Select label={t("module")} value={moduleId} onChange={(e) => setModuleId(e.target.value)} disabled={pending}><option value="">{t("allModules")}</option>{modules.map((module) => <option key={module.id} value={module.id}>{module.name}</option>)}</Select>
      {error != null && <p role="alert" className="field-error">{error instanceof Error ? error.message : t("failed")}{error instanceof ApiError && error.requestId ? ` · ${error.requestId}` : ""}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><Button type="button" onClick={onClose} disabled={pending}>{t("cancel")}</Button><Button type="submit" variant="primary" disabled={pending || !name.trim() || !date} aria-busy={pending}>{t("create")}</Button></div>
    </form>
  </Dialog>;
}
