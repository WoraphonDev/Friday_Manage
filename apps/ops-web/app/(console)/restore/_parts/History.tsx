"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Empty, ErrorBlock, Pager, TableSkeleton } from "@/components/kit";
import { Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import type { HistoryItem } from "./types";

/** ประวัติการกู้คืนและยืดเวลา (staff_audit_logs action restore.*) */
export function History() {
  const t = useTranslations("rst.history");
  const fmt = useFmt();
  // เดิมตัดที่ 100 รายการ · ตอนนี้แบ่งหน้าและบอกจำนวนทั้งหมด
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ["ops", "restore", "history", offset], queryFn: () => api.get<{ items: HistoryItem[]; total: number }>(`/restore/history?limit=50&offset=${offset}`), placeholderData: keepPreviousData });
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
      {q.data?.total != null && (
        <div style={{ padding: "10px 16px" }}>
          <Pager offset={offset} limit={50} shown={q.data.items.length} total={q.data.total} onChange={setOffset} />
        </div>
      )}
    </section>
  );
}
