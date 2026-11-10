"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { Modal } from "@/components/kit";
import { Button, InlineError, Input, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import type { WsList } from "../../../workspaces/_parts/types";
import { type Agent, SETTINGS_KEY } from "./types";

/** ผู้ดูแลประจำบัญชี (Enterprise) ของพนักงานหนึ่งคน · บันทึกทั้งชุด */
export function AccountsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const t = useTranslations("sset.accounts");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [picked, setPicked] = useState(agent.accounts);
  const [q, setQ] = useState("");
  const term = useDeferredValue(q.trim());
  const found = useQuery({
    queryKey: ["ops", "workspaces", "pick", term],
    queryFn: () => api.get<WsList>(`/workspaces?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const m = useMutation({
    mutationFn: () => api.put(`/support/agents/${agent.staffId}/accounts`, { workspaceIds: picked.map((w) => w.id) }),
    onSuccess: () => (toast(t("done")), void cache.invalidateQueries({ queryKey: ["ops", "support"] }), onClose()),
  });
  const options = (found.data?.items ?? []).filter((w) => !picked.some((p) => p.id === w.id));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title", { name: agent.name })} description={t("desc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        {picked.length ? (
          <ul className="row plain-list">
            {picked.map((w) => (
              <li key={w.id} className="chip chip-static">
                {w.name}
                <button type="button" className="link-button" aria-label={t("remove", { name: w.name })} onClick={() => setPicked(picked.filter((x) => x.id !== w.id))}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("none")}</p>
        )}
        <Input label={t("search")} value={q} onChange={(e) => setQ(e.target.value)} placeholder="orbit" />
        {term.length >= 2 && (
          <div className="stack-tight">
            {options.length ? (
              options.map((w) => (
                <button key={w.id} type="button" className="menu-item" aria-label={t("add", { name: w.name })} onClick={() => (setPicked([...picked, { id: w.id, name: w.name }]), setQ(""))}>
                  <span className="cell-strong">{w.name}</span>
                  <span className="muted small">{w.slug}</span>
                </button>
              ))
            ) : found.isFetched ? (
              <p className="muted small">{t("noResult")}</p>
            ) : null}
          </div>
        )}
        <p className="muted small">{t("moved")}</p>
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="primary" disabled={m.isPending}>
            {tc("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
