"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { Modal } from "@/components/kit";
import { Button, errorToast, InlineError, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import styles from "../bugs.module.css";
import { RelinkDialog } from "./IssuePicker";
import { NotifyDialog } from "./NotifyDialog";
import { ResolveDialog } from "./ResolveDialog";
import { BRIDGE_KEY, type LinkDetail, severityTone, useStatusLabel } from "./types";

/**
 * T8 · การ์ด "งานของทีมพัฒนา" ในหน้า Ticket (คอลัมน์ขวา) · แสดงเมื่อ Ticket ผูกกับงานใน FM
 * Support: แจ้งลูกค้า (T9) / ไม่แก้-ซ้ำ (T10) / เปลี่ยนงาน (T7) / ยกเลิกการผูก · บทบาทอื่นดูอย่างเดียว
 */
export function DevCard({ ticketId, number }: { ticketId: string; number: number }) {
  const t = useTranslations("bugs.t8");
  const tc = useTranslations("common.dialog");
  const fmt = useFmt();
  const me = useMe().data;
  const toast = useToast();
  const cache = useQueryClient();
  const label = useStatusLabel();
  const support = hasAny(me, "support");
  const q = useQuery({
    queryKey: [...BRIDGE_KEY, "ticket", ticketId],
    queryFn: () => api.get<{ link: LinkDetail | null; configured: boolean }>(`/dev-bridge/tickets/${ticketId}`),
    enabled: hasAny(me, "owner", "support", "engineer"),
    retry: false,
  });
  const [dialog, setDialog] = useState<"notify" | "resolve" | "relink" | "unlink" | null>(null);
  const unlink = useMutation({
    mutationFn: () => api.delete(`/dev-bridge/tickets/${ticketId}/link`),
    onSuccess: () => (toast({ message: t("unlinked") }), void cache.invalidateQueries({ queryKey: ["ops"] }), setDialog(null)),
    onError: (e) => toast(errorToast(e)),
  });
  const l = q.data?.link;
  if (!l) return null;
  const st = label(l);
  const done = l.statusCategory === "done";
  return (
    <section className={`card ${styles.devCard}`} aria-label={t("title")}>
      <div className="card-head">
        <Bug size={16} aria-hidden="true" />
        <h3 className="card-title">{t("title")}</h3>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <b className="mono">{l.issueKey}</b>
        <Pill tone={st.tone}>{st.text}</Pill>
        <Pill tone={severityTone(l.severity)}>{l.severity}</Pill>
      </div>
      <p className={styles.devTitle}>{l.title}</p>
      <dl className={styles.kv}>
        <dt>{t("assignee")}</dt>
        <dd>{l.assigneeName ?? "—"}</dd>
        <dt>{t("sprint")}</dt>
        <dd>{l.sprintName ?? "—"}</dd>
        {l.dueDate && (
          <>
            <dt>{t("due")}</dt>
            <dd>{fmt.date(l.dueDate)}</dd>
          </>
        )}
        <dt>{t("released")}</dt>
        <dd>{l.releasedAt ? `${fmt.dateTime(l.releasedAt)}${l.releaseVersion ? ` · ${l.releaseVersion}` : ""}` : "—"}</dd>
        <dt>{t("synced")}</dt>
        <dd>{fmt.ago(l.syncedAt)}</dd>
      </dl>
      <div className="field-label">{t("tickets", { n: l.tickets.length })}</div>
      <ul className={styles.ticketList}>
        {l.tickets.map((k) => (
          <li key={k.id}>
            <span>
              #{k.number} {k.workspace ?? ""}
            </span>
            {k.outcome === "returned" ? <Pill>{t("returned")}</Pill> : k.notifiedAt ? <Pill tone="ok">{t("notified")}</Pill> : <Pill tone="inf">{t("waiting")}</Pill>}
          </li>
        ))}
      </ul>
      {support && l.unnotified > 0 && done && (
        <Button variant="primary" onClick={() => setDialog("notify")}>
          {t("notify")}
        </Button>
      )}
      {support && l.unnotified > 0 && !!l.resolution && (
        <Button variant="primary" onClick={() => setDialog("resolve")}>
          {t("resolve")}
        </Button>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {l.url && (
          <a className="button button-small" href={l.url} target="_blank" rel="noreferrer noopener">
            {t("open")}
          </a>
        )}
        {support && (
          <>
            <Button size="small" onClick={() => setDialog("relink")}>
              {t("change")}
            </Button>
            <Button size="small" onClick={() => setDialog("unlink")}>
              {t("unlink")}
            </Button>
          </>
        )}
      </div>
      {dialog === "notify" && <NotifyDialog linkId={l.id} onClose={() => setDialog(null)} />}
      {dialog === "resolve" && <ResolveDialog link={l} onClose={() => setDialog(null)} />}
      {dialog === "relink" && <RelinkDialog ticketId={ticketId} number={number} onClose={() => setDialog(null)} />}
      {dialog === "unlink" && (
        <Modal open onOpenChange={(o) => !o && setDialog(null)} title={t("unlinkTitle", { n: number, key: l.issueKey })} description={t("unlinkDesc")}>
          <div className="dialog-body">
            <InlineError error={unlink.error} />
            <div className="dialog-actions">
              <Button onClick={() => setDialog(null)}>{tc("cancel")}</Button>
              <Button variant="danger" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
                {t("unlink")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
