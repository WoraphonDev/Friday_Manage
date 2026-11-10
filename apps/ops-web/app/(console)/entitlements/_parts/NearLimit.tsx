"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { hasAny } from "@/components/access";
import { Empty } from "@/components/kit";
import { Button, errorToast, Pill, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { useFmt } from "../../workspaces/_parts/format";
import { type Near, PLAN_NAME } from "./types";

/** ใกล้ชนเพดาน · ใช้เกิน 85% ของขีดจำกัด · ส่งต่อให้ทีมขาย */
export function NearLimit({ items }: { items: Near[] }) {
  const t = useTranslations("ent.near");
  const tk = useTranslations("ent.keys");
  const fmt = useFmt();
  const toast = useToast();
  const cache = useQueryClient();
  const me = useMe().data;
  const write = hasAny(me, "owner", "finance", "engineer");
  const refer = useMutation({
    mutationFn: (n: Near) => api.post(`/entitlements/near-limit/${n.workspace.id}/refer`, { key: n.key }).then(() => n),
    onSuccess: (n) => (toast(t("referDone", { ws: n.workspace.name })), void cache.invalidateQueries({ queryKey: ["ops", "entitlements"] })),
    onError: (e) => toast(errorToast(e)),
  });
  const eta = (d: number | null) => {
    if (d === 0) return t("full");
    if (d == null) return t("etaUnknown");
    if (d < 14) return t("etaDays", { days: d });
    if (d < 60) return t("etaWeeks", { weeks: Math.round(d / 7) });
    return t("etaMonths", { months: Math.round(d / 30) });
  };
  const used = (n: Near) => (n.key === "storage" ? `${fmt.bytes(n.used)} / ${fmt.bytes(n.limit)}` : `${fmt.num(n.used)}/${fmt.num(n.limit)}`);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        {items.length > 0 && <Pill tone="warn">{t("count", { count: items.length })}</Pill>}
        <span className="card-sub">{t("note")}</span>
      </div>
      {!items.length ? (
        <Empty ok title={t("empty")} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.ws")}</th>
                <th scope="col">{t("col.plan")}</th>
                <th scope="col">{t("col.what")}</th>
                <th scope="col">{t("col.used")}</th>
                <th scope="col">{t("col.eta")}</th>
                {write && (
                  <th scope="col">
                    <span className="sr-only">{t("col.actions")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={`${n.workspace.id}:${n.key}`}>
                  <td>
                    <div className="cell-main">{n.workspace.name}</div>
                    <div className="cell-sub">{n.workspace.slug}</div>
                  </td>
                  <td>
                    <Pill>{PLAN_NAME[n.plan]}</Pill>
                  </td>
                  <td>{tk(n.key)}</td>
                  <td>
                    <span className="meter">
                      <span className="hbar-track" role="presentation">
                        <span className={`hbar ${n.ratio >= 0.9 ? "hbar-bad" : "hbar-warn"}`} style={{ width: `${Math.min(100, Math.round(n.ratio * 100))}%` }} />
                      </span>
                      <span className="num">{used(n)}</span>
                    </span>
                  </td>
                  <td className="muted">{eta(n.etaDays)}</td>
                  {write && (
                    <td>
                      {n.referredAt ? (
                        <Pill tone="ok">{t("referred", { date: fmt.date(n.referredAt) })}</Pill>
                      ) : (
                        <Button size="small" disabled={refer.isPending} onClick={() => refer.mutate(n)}>
                          {t("refer")}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
