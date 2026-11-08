"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, Dialog, ErrorState, LoadingState, Select, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WorkspaceMember } from "../../p/[key]/members/_components/types";
import styles from "../../p/[key]/members/_components/members.module.css";

interface Handover {
  assignedIssues: { total: number; items: { key: string; title: string; project: string; planEnd: string | null }[] };
  ownedProjects: { key: string; name: string }[];
}
const SHOW = 8;

/** ⋯ ของสมาชิก Workspace: ปิดการใช้งานพร้อมโอนงาน (P3) หรือเปิดใช้งานอีกครั้ง */
export function ManageDialog({
  ws,
  member,
  others,
  onClose,
  onDone,
}: {
  ws: string;
  member: WorkspaceMember;
  others: WorkspaceMember[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const t = useTranslations("members-workload.ws");
  const tc = useTranslations("common.app");
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}`;
  const active = member.status === "active";
  const [to, setTo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const handover = useQuery({
    queryKey: ["handover", ws, member.userId],
    queryFn: () => api.get<Handover>(`${base}/members/${member.userId}/handover`),
    enabled: active,
    gcTime: 0,
  });

  /** โอนทีละงานด้วย assignees ล่าสุด (ไม่ทับ Dev คนอื่นในงานเดียวกัน) · งานที่ชนกัน / ไม่มีสิทธิ์ แจ้งรายการไว้ */
  async function transfer(items: Handover["assignedIssues"]["items"], target: WorkspaceMember) {
    const failed: string[] = [];
    for (const item of items) {
      const path = `${base}/issues/${encodeURIComponent(item.key)}`;
      try {
        const issue = await api.get<{ assigneeIds: string[]; version: number }>(path);
        const next = issue.assigneeIds.filter((id) => id !== member.userId);
        if (!next.includes(target.userId)) next.push(target.userId);
        await api.request(`${path}/assignees`, { method: "PUT", etag: issue.version, body: { assigneeIds: next, planChangeReason: t("transferReason", { name: member.displayName }) } });
      } catch {
        failed.push(item.key);
      }
    }
    return failed;
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : tc("unknownError"));
    } finally {
      setPending(false);
    }
  }

  const deactivate = () =>
    run(async () => {
      const target = others.find((m) => m.userId === to);
      const items = handover.data?.assignedIssues.items ?? [];
      if (target && items.length) {
        const failed = await transfer(items, target);
        toast({ message: failed.length ? t("transferFailed", { count: failed.length, keys: failed.join(", ") }) : t("transferred", { count: items.length }) });
      }
      await api.post(`${base}/members/${member.userId}/deactivate`);
      toast({ message: t("deactivated_toast", { name: member.displayName }) });
    });
  const reactivate = () =>
    run(async () => {
      await api.post(`${base}/members/${member.userId}/reactivate`);
      toast({ message: t("reactivated", { name: member.displayName }) });
    });

  const h = handover.data;
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()} title={active ? t("deactivateTitle", { name: member.displayName }) : t("options", { name: member.displayName })}>
      <div className={styles.dialogBody}>
        {!active ? (
          <div className={styles.actions}>
            <Button variant="primary" disabled={pending} onClick={() => void reactivate()}>{t("reactivate")}</Button>
          </div>
        ) : handover.isPending ? (
          <LoadingState />
        ) : handover.error ? (
          <ErrorState error={handover.error} retry={() => handover.refetch()} />
        ) : (
          <>
            <p className={cn(styles.muted, styles.small)} style={{ margin: 0 }}>{t("deactivateHint")}</p>
            <strong>{h!.assignedIssues.total ? t("handoverTitle", { count: h!.assignedIssues.total }) : t("handoverNone")}</strong>
            {h!.assignedIssues.items.length > 0 && (
              <div className={styles.handover} role="list">
                {h!.assignedIssues.items.slice(0, SHOW).map((i) => (
                  <span key={i.key} role="listitem"><b>{i.key}</b> {i.title}</span>
                ))}
                {h!.assignedIssues.total > SHOW && <span className={styles.muted}>{t("handoverMore", { count: h!.assignedIssues.total - SHOW })}</span>}
              </div>
            )}
            {h!.ownedProjects.length > 0 && <span className={styles.up}>{t("ownedProjects", { projects: h!.ownedProjects.map((p) => p.name).join(", ") })}</span>}
            {h!.assignedIssues.items.length > 0 && (
              <Select label={t("transferTo")} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t("noTransfer")}</option>
                {others.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
              </Select>
            )}
            <div className={styles.actions}>
              <Button disabled={pending} onClick={onClose}>{tc("cancel")}</Button>
              <Button variant="danger" disabled={pending} onClick={() => void deactivate()}>{pending ? t("deactivating") : t("deactivate")}</Button>
            </div>
          </>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
