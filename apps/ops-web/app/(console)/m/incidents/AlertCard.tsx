"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import { Notice } from "@/components/kit";
import { Button, InlineError, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import type { SystemAlert } from "../../system/ErrorRate";

/**
 * S12 · เปิดจาก Push "Error rate เกิน" (/m/incidents?alert=…) · ข้อมูลตอนนี้ + เปิดเหตุขัดข้อง / รับทราบ
 * "รับทราบ" บอกทีมว่ามีคนดูแล้ว และหยุดแจ้งซ้ำ
 */
export function AlertCard() {
  const t = useTranslations("mob.incidents.alert");
  const f = useFormatter();
  const me = useMe().data;
  const router = useRouter();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({ queryKey: ["ops", "system", "alerts"], queryFn: () => api.get<{ open: SystemAlert | null }>("/system/alerts"), refetchInterval: 30_000 });
  const done = () => void cache.invalidateQueries({ queryKey: ["ops"] });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/system/alerts/${id}/acknowledge`, {}), onSuccess: () => (toast(t("ackDone")), done()) });
  const open = useMutation({
    mutationFn: (id: string) => api.post<{ incidentId: string }>(`/system/alerts/${id}/incident`, {}),
    onSuccess: (r) => (toast(t("opened")), done(), router.replace(`/m/incidents?id=${r.incidentId}`)),
  });
  const a = q.data?.open;
  if (!a) return null;
  const d = a.details;
  const minutes = Math.max(1, Math.round((Date.now() - new Date(a.startedAt).getTime()) / 60_000));
  const canOpen = hasAny(me, "engineer", "support");
  const canAck = hasAny(me, "engineer", "owner");
  return (
    <section className="m-card" aria-label={t("label")}>
      <Notice tone={d.normalSince ? "warn" : "bad"} title={t("over", { rate: `${d.ratePct}%` })}>
        {d.normalSince ? t("recovering") : t("overFor", { n: minutes })}
      </Notice>
      <h2 className="card-title">{t("now")}</h2>
      <ul className="m-rows">
        <li>
          <span className="muted">{t("ratio")}</span>
          <span className="num">
            {f.number(d.errors)} / {f.number(d.total)}
          </span>
        </li>
        {d.topRoute && (
          <li>
            <span className="muted">{t("route")}</span>
            <span className="mono small">{d.topRoute}</span>
          </li>
        )}
        <li>
          <span className="muted">{t("p95")}</span>
          <span>{d.p95Ms == null ? "—" : d.p95Ms >= 1000 ? t("seconds", { n: f.number(d.p95Ms / 1000, { maximumFractionDigits: 1 }) }) : t("ms", { n: d.p95Ms })}</span>
        </li>
      </ul>
      {a.acknowledgedBy && a.acknowledgedAt && <p className="muted small">{t("acked", { name: a.acknowledgedBy.name, time: f.dateTime(new Date(a.acknowledgedAt), { timeStyle: "short" }) })}</p>}
      <InlineError error={ack.error ?? open.error} />
      <div className="m-actions">
        {a.incidentId ? (
          <Button className="m-btn m-wide" onClick={() => router.replace(`/m/incidents?id=${a.incidentId}`)}>
            {t("view")}
          </Button>
        ) : (
          canOpen && (
            <Button variant="primary" className="m-btn m-wide" disabled={open.isPending} onClick={() => open.mutate(a.id)}>
              {t("open")}
            </Button>
          )
        )}
        {canAck && !a.acknowledgedAt && (
          <Button className="m-btn m-wide" disabled={ack.isPending} onClick={() => ack.mutate(a.id)}>
            {t("ack")}
          </Button>
        )}
      </div>
    </section>
  );
}
