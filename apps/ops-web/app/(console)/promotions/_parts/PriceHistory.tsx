"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Empty, ErrorBlock, TableSkeleton } from "@/components/kit";
import { Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useFmt } from "../../workspaces/_parts/format";
import { type PriceVersion, PROMO_KEY } from "./types";

/** แท็บประวัติราคา · ทุกเวอร์ชันของทุกแพ็กเกจ (ใหม่สุดก่อน) · แก้หรือลบไม่ได้ */
export function PriceHistory() {
  const t = useTranslations("promo.history");
  const fmt = useFmt();
  const q = useQuery({ queryKey: [...PROMO_KEY, "price-history"], queryFn: () => api.get<{ items: PriceVersion[] }>("/promotions/price-history") });
  const value = (c: PriceVersion["changes"][number], v: string | number | boolean | null) => {
    if (c.field === "monthly" || c.field === "yearly") return v === null ? t("defaultPrice") : fmt.money(v as number);
    if (c.field === "listed") return v ? t("shown") : t("hiddenValue");
    if (c.field === "openForSignup") return v ? t("open") : t("closedValue");
    return v === null || v === "" ? "—" : String(v);
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("desc")}</span>
      </div>
      {q.isPending ? (
        <TableSkeleton rows={4} cols={7} />
      ) : q.error ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <Empty title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.plan")}</th>
                <th scope="col">{t("col.version")}</th>
                <th scope="col">{t("col.effective")}</th>
                <th scope="col">{t("col.changes")}</th>
                <th scope="col">{t("col.policy")}</th>
                <th scope="col">{t("col.reason")}</th>
                <th scope="col">{t("col.by")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((v) => (
                <tr key={v.id}>
                  <td className="cell-main">{v.planName}</td>
                  <td>
                    <span className="row">
                      {t("version", { version: v.version })}
                      {v.status === "current" && <Pill tone="inf">{t("current")}</Pill>}
                    </span>
                  </td>
                  <td className="num">{fmt.date(v.effectiveAt)}</td>
                  <td className="cell-wrap">
                    {v.changes.length ? (
                      <ul className="plain-list small">
                        {v.changes.map((c) => (
                          <li key={c.field}>
                            {t(`fields.${c.field}`)}: <span className="muted">{value(c, c.from)}</span> → <b>{value(c, c.to)}</b>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted small">{t("first")}</span>
                    )}
                  </td>
                  <td className="small">{v.existingPolicy === "next_cycle" ? t("nextCycle", { date: fmt.date(v.existingFrom) }) : t("grandfather")}</td>
                  <td className="cell-wrap small">{v.reason}</td>
                  <td className="small">
                    {v.createdBy ?? t("system")}
                    {v.approvedBy && <span className="cell-sub" style={{ display: "block" }}>{t("approvedBy", { name: v.approvedBy })}</span>}
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
