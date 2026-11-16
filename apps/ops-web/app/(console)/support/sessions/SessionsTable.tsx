"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { ErrorBlock, TableSkeleton } from "@/components/kit";
import { Button, errorToast, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import type { OpenSession, SessionsResponse } from "@/lib/types";

const MIN = 60_000;

/**
 * การเข้าช่วยเหลือ (Support › การเข้าช่วยเหลือ · H8): เปิดอยู่ + ที่จบใน 30 วัน
 * คอลัมน์ "หมดเวลา / จบ" และ "ใช้ไป" มาจากเซิร์ฟเวอร์ (expiresAt · endReason · usedMinutes) · งานทุก 1 นาทีปิดเซสชันที่หมดเวลาให้แล้ว
 */
export function Sessions() {
  const t = useTranslations("ss.support");
  const tc = useTranslations("common");
  const format = useFormatter();
  const toast = useToast();
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: ["ops", "support-sessions", "recent"],
    queryFn: async () => {
      const r = await api.get<SessionsResponse>("/support-sessions?scope=recent");
      return { ...r, offset: r.serverTime ? Date.parse(r.serverTime) - Date.now() : 0 };
    },
    refetchInterval: 60_000,
  });
  const end = useMutation({
    mutationFn: (id: string) => api.post(`/support-sessions/${id}/end`),
    onSuccess: () => (toast(t("ended")), void cache.invalidateQueries({ queryKey: ["ops"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const now = Date.now() + (q.data?.offset ?? 0);
  const time = (iso: string) => {
    const d = new Date(iso);
    const today = new Date(now).toDateString() === d.toDateString();
    return format.dateTime(d, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" });
  };
  const short = (iso: string) => format.dateTime(new Date(iso), { timeStyle: "short" });
  const open = q.data?.items.filter((s) => !s.endedAt).length ?? 0;
  const status = (s: OpenSession) => {
    if (!s.endedAt) {
      const left = s.expiresAt ? Math.max(0, Math.ceil((Date.parse(s.expiresAt) - now) / MIN)) : null;
      return <span className="pill warn">{left === null ? t("sessionTable.open", { n: "—" }) : t("sessionTable.open", { n: left })}</span>;
    }
    return <span className="pill">{s.endReason === "expired" ? t("sessionTable.expired") : t("sessionTable.ended")}</span>;
  };
  const ending = (s: OpenSession) => {
    if (!s.endedAt) return s.expiresAt ? short(s.expiresAt) : "—";
    return s.endReason === "expired" ? t("sessionTable.endExpired", { time: short(s.endedAt) }) : t("sessionTable.endManual", { time: short(s.endedAt) });
  };
  const used = (s: OpenSession) => s.usedMinutes ?? Math.max(0, Math.round(((s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.startedAt)) / MIN));
  return (
    <section className="card" id="sessions">
      <div className="card-head">
        <h2 className="card-title">{t("sessions")}</h2>
        {q.data && <span className="card-sub">{t("sessionsRecent", { open, n: q.data.items.length })}</span>}
      </div>
      {q.isPending ? (
        <TableSkeleton rows={2} cols={8} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <p className="muted small">{t("noSessionsRecent")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {(["who", "customer", "ticket", "mode", "start", "end", "used", "status"] as const).map((c) => (
                  <th key={c} className={c === "used" ? "num" : undefined}>
                    {t(`sessionTable.${c}`)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={s.id}>
                  <td>{s.staffRoles?.length ? t("sessionTable.whoRole", { name: s.staffName, role: tc(`roles.${s.staffRoles[0]}`) }) : s.staffName}</td>
                  <td>{s.workspace.name}</td>
                  <td className="mono small">{s.ticketNo}</td>
                  <td>{s.mode === "write" ? t("write") : t("read")}</td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>
                    {time(s.startedAt)}
                  </td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>
                    {ending(s)}
                  </td>
                  <td className="num small">{t("sessionTable.usedMin", { n: used(s) })}</td>
                  <td>{status(s)}</td>
                  <td>
                    {!s.endedAt && (
                      <Button size="small" disabled={end.isPending} onClick={() => end.mutate(s.id)}>
                        {t("end")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
