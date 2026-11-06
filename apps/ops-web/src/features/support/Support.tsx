"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, LoadingState, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, minutesBetween } from "@/lib/format";
import { keys } from "@/lib/query";
import type { OpenSession } from "@/lib/types";
import { PageHeader, useStaff } from "../shell/Shell";

/** support session ที่ยังเปิดอยู่ (GET ops/support-sessions) · จบได้เฉพาะเจ้าของ session หรือ Admin */
export function Support() {
  const t = useTranslations("ops");
  const staff = useStaff();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: keys.sessions, queryFn: () => api.get<{ items: OpenSession[] }>("/support-sessions") });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => {
      toast(t("session.ended"));
      void cache.invalidateQueries({ queryKey: keys.sessions });
    },
    onError: (e) => toast(e.message),
  });
  return (
    <>
      <PageHeader title={t("titles.support")} desc={t("titles.supportDesc")} />
      <section className="card">
        <div className="ch">
          <h2>{t("sup.title")}</h2>
          <span className="muted small-13">{t("sup.note")}</span>
        </div>
        {q.isPending ? (
          <LoadingState />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title={t("sup.empty")} description={t("sup.emptyDesc")} />
        ) : (
          q.data.items.map((s) => (
            <div className="pr" key={s.id}>
              <span className="muted w-120">{formatDateTime(s.startedAt)}</span>
              <b className="w-150">{s.workspace.name}</b>
              <span className="w-80">{s.staffName}</span>
              <span className="grow-220">
                {s.ticketNo} {s.reason}
              </span>
              <Pill tone={s.mode === "write" ? "warn" : "neu"}>{s.mode === "write" ? `${t("modes.write")} · ${t("sup.approvedBy")}` : t("modes.read")}</Pill>
              <span className="muted">{t("sup.inUse", { minutes: minutesBetween(s.startedAt, s.endedAt) })}</span>
              {(s.staffId === staff?.id || staff?.role === "admin") && (
                <Button size="small" disabled={end.isPending} onClick={() => end.mutate(s.id)}>
                  {t("sup.end")}
                </Button>
              )}
            </div>
          ))
        )}
      </section>
    </>
  );
}
