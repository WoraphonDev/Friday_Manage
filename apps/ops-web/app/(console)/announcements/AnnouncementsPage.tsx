"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Empty, ErrorBlock, Modal, NoAccess, PageHead, TableSkeleton } from "@/components/kit";
import { Button, buttonClass, InlineError, Pill, Textarea, type Tone, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import type { AnnouncementItem } from "../workspaces/_parts/Announce";
import { useFmt } from "../workspaces/_parts/format";

export const ANN_KEY = ["ops", "announcements"] as const;
const TONE: Record<AnnouncementItem["status"], Tone> = { scheduled: "inf", sent: "ok", cancelled: "neu", stopped: "warn", draft: "neu" };

/**
 * ประกาศถึงลูกค้า (เมนู "ประกาศถึงลูกค้า" · O24) · ประวัติประกาศที่ส่งและตั้งเวลาไว้ ยกเลิก / หยุดแบนเนอร์ได้
 * Canvas ให้เป็นแท็บใน Promotions ที่ยังไม่มีหน้า (O20) จึงเป็นหน้าแยกไปก่อน · ส่งใหม่เริ่มจาก Workspaces (C8)
 */
export function AnnouncementsPage() {
  const t = useTranslations("ann.page");
  const fmt = useFmt();
  const me = useMe().data;
  const owner = hasAny(me, "owner");
  const [cancelling, setCancelling] = useState<AnnouncementItem | null>(null);
  const q = useQuery({ queryKey: ANN_KEY, queryFn: () => api.get<{ items: AnnouncementItem[]; bannerDays: number }>("/announcements"), enabled: !!me && owner });
  if (me && !owner) return <NoAccess need={["owner"]} mine={rolesOf(me)} />;
  const items = q.data?.items ?? [];
  const toWorkspaces = (
    <Link className={buttonClass("primary")} href="/workspaces">
      {t("new")}
    </Link>
  );
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} actions={toWorkspaces} />
      <section className="card">
        {q.isPending ? (
          <TableSkeleton rows={4} cols={6} />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : !items.length ? (
          <Empty title={t("empty")} description={t("emptyDesc")} />
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t("col.title")}</th>
                    <th scope="col">{t("col.to")}</th>
                    <th scope="col">{t("col.channels")}</th>
                    <th scope="col">{t("col.when")}</th>
                    <th scope="col">{t("col.result")}</th>
                    <th scope="col">{t("col.status")}</th>
                    <th scope="col">
                      <span className="sr-only">{t("cancel")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => {
                    const title = a.title ?? a.message.slice(0, 80);
                    const names = a.workspaces.names.join(", ");
                    return (
                      <tr key={a.id}>
                        <td>
                          <span className="cell-main">{title}</span>
                          <span className="cell-sub" style={{ display: "block" }}>
                            {a.createdBy ? t("by", { name: a.createdBy }) : ""} · {fmt.dateTime(a.createdAt)}
                          </span>
                        </td>
                        <td>
                          <span className="cell-main">{a.workspaces.count > a.workspaces.names.length ? t("wsMore", { names, more: a.workspaces.count - a.workspaces.names.length }) : names || "—"}</span>
                          {a.recipients != null && (
                            <span className="cell-sub" style={{ display: "block" }}>
                              {t("people", { count: a.recipients })}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="row">
                            {a.channels.map((c) => (
                              <span key={c} className="pill">
                                {c === "email" ? t("channel.email") : t("channel.banner")}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="num">{fmt.dateTime(a.sentAt ?? a.scheduledAt)}</td>
                        <td className="small">{a.email ? t("result", a.email) : t("noEmail")}</td>
                        <td>
                          <Pill tone={TONE[a.status]}>{t(`status.${a.status}`)}</Pill>
                        </td>
                        <td>
                          {a.canCancel && (
                            <Button size="small" onClick={() => setCancelling(a)}>
                              {a.sentAt ? t("stop") : t("cancel")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small">{t("bannerNote", { days: q.data?.bannerDays ?? 30 })}</p>
          </>
        )}
      </section>
      {cancelling && <CancelDialog item={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}

/** ยกเลิกก่อนส่ง / หยุดแบนเนอร์หลังส่ง · ลง Audit ของทุก Workspace ที่เลือก */
function CancelDialog({ item, onClose }: { item: AnnouncementItem; onClose: () => void }) {
  const t = useTranslations("ann.page");
  const tc = useTranslations("common.dialog");
  const toast = useToast();
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const sent = !!item.sentAt;
  const title = item.title ?? item.message.slice(0, 80);
  const m = useMutation({
    mutationFn: () => api.post<AnnouncementItem>(`/announcements/${item.id}/cancel`, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: () => {
      toast({ message: sent ? t("stoppedDone") : t("cancelled") });
      void cache.invalidateQueries({ queryKey: ANN_KEY });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={sent ? t("stopTitle", { title }) : t("cancelTitle", { title })} description={sent ? t("stopDesc") : t("cancelDesc")}>
      <form className="dialog-body" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <Textarea label={t("reason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        <InlineError error={m.error} />
        <div className="dialog-actions">
          <Button onClick={onClose}>{tc("cancel")}</Button>
          <Button type="submit" variant="danger" disabled={m.isPending}>
            {sent ? t("confirmStop") : t("confirmCancel")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
