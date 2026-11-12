"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Empty, ErrorBlock, TableSkeleton } from "@/components/kit";
import { Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import type { HistoryItem } from "./types";

/** ประวัติการกู้คืนและยืดเวลา (staff_audit_logs action restore.*) */
export function History() {
  const t = useTranslations("rst.history");
  const fmt = useFmt();
  const q = useQuery({ queryKey: ["ops", "restore", "history"], queryFn: () => api.get<{ items: HistoryItem[] }>("/restore/history") });
  const label = (action: string) => {
    const key = `actions.${action.replace(/\./g, "_")}` as "actions.restore_issue";
    return t.has(key) ? t(key) : action;
  };
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-head" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)" }}>
        <h2 className="card-title">{t("title")}</h2>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={5} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.at")}</th>
                <th scope="col">{t("col.action")}</th>
                <th scope="col">{t("col.ws")}</th>
                <th scope="col">{t("col.detail")}</th>
                <th scope="col">{t("col.by")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((h) => (
                <tr key={h.id}>
                  <td className="small num">{fmt.dateTime(h.createdAt)}</td>
                  <td>{label(h.action)}</td>
                  <td>{h.workspaceName ?? "—"}</td>
                  <td className="small">{h.reason}</td>
                  <td className="small">
                    {h.staffName ?? "—"}
                    {h.approvedBy && (
                      <div>
                        <Pill tone={h.selfApproved ? "warn" : "ok"}>{h.selfApproved ? t("approvedSelf") : t("approved")}</Pill>
                      </div>
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
