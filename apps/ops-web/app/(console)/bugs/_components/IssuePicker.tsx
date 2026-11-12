"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useState } from "react";
import { ErrorBlock, Modal, TableSkeleton } from "@/components/kit";
import { Button, InlineError, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "../bugs.module.css";
import { BRIDGE_KEY, categoryTone, type FmIssue } from "./types";

/** T7 · ค้นงาน Bug ในโปรเจกต์ FM แล้วเลือก (ใช้ใน T3 และเปลี่ยนงานจากการ์ด T8) */
export function IssueSearch({ selected, onSelect, initial = "" }: { selected: string | null; onSelect: (issue: FmIssue) => void; initial?: string }) {
  const t = useTranslations("bugs.t7");
  const [q, setQ] = useState(initial);
  const term = useDeferredValue(q.trim());
  const r = useQuery({
    queryKey: [...BRIDGE_KEY, "issues", term],
    queryFn: () => api.get<{ items: FmIssue[] }>(`/dev-bridge/issues?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  return (
    <div className="stack-tight">
      <label className={styles.searchBox}>
        <Search size={16} aria-hidden="true" />
        <input type="search" aria-label={t("search")} placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {term.length >= 2 &&
        (r.isPending ? (
          <TableSkeleton rows={3} cols={1} />
        ) : r.error ? (
          <ErrorBlock error={r.error} retry={() => void r.refetch()} />
        ) : !r.data.items.length ? (
          <p className="muted small">{t("none")}</p>
        ) : (
          <ul className={styles.results} role="listbox" aria-label={t("label")}>
            {r.data.items.map((i) => (
              <li
                key={i.key}
                role="option"
                aria-selected={selected === i.key}
                className={selected === i.key ? styles.resultOn : undefined}
                onClick={() => onSelect(i)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(i))}
                tabIndex={0}
              >
                <span className={styles.resultText}>
                  <b className="mono">{i.key}</b> {i.title}
                  <span className="muted small" style={{ display: "block" }}>
                    {i.priority} · {t("linked", { n: i.linkedTickets })}
                  </span>
                </span>
                <Pill tone={categoryTone(i.status.category)}>{i.status.name}</Pill>
              </li>
            ))}
          </ul>
        ))}
      <p className="muted small">{t("note")}</p>
    </div>
  );
}

/** T7 จากการ์ด T8: เปลี่ยนงานที่ผูกกับ Ticket */
export function RelinkDialog({ ticketId, number, onClose }: { ticketId: string; number: number; onClose: () => void }) {
  const t = useTranslations("bugs.t7");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [pick, setPick] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.post(`/dev-bridge/tickets/${ticketId}/link`, { issueKey: pick }),
    onSuccess: () => (toast({ message: t("done", { n: number, key: pick! }) }), void cache.invalidateQueries({ queryKey: ["ops"] }), onClose()),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("title")}>
      <div className="dialog-body">
        <IssueSearch selected={pick} onSelect={(i) => setPick(i.key)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button variant="primary" disabled={!pick || m.isPending} onClick={() => m.mutate()}>
            {pick ? t("submit", { n: number, key: pick }) : t("label")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
