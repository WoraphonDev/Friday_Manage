"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny, rolesOf } from "@/components/access";
import { Empty, ErrorBlock, NoAccess, Notice, PageHead, TableSkeleton, Tabs } from "@/components/kit";
import { Button, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { AnnouncementsPage } from "../announcements/AnnouncementsPage";
import { useFmt } from "../workspaces/_parts/format";
import { CouponDrawer, formOf } from "./_parts/CouponDrawer";
import { type CouponAction, CouponMenu } from "./_parts/CouponMenu";
import { PlanDrawer } from "./_parts/PlanDrawer";
import { PriceHistory } from "./_parts/PriceHistory";
import { type Overview, PLAN_NAME, type PlanRow, PROMO_KEY, STATE_TONE, useCouponText } from "./_parts/types";

type Tab = "plans" | "campaigns" | "announce" | "history";
type CouponDrawerState = { kind: "create" } | CouponAction | null;

/** หน้าแพ็กเกจและโปรโมชัน (Canvas › Promotions · เฟส 2 · O20) · Owner / การเงิน */
export function PromotionsPage() {
  const t = useTranslations("promo");
  const fmt = useFmt();
  const me = useMe().data;
  const allowed = hasAny(me, "owner", "finance");
  const [tab, setTab] = useState<Tab>("plans");
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [couponDrawer, setCouponDrawer] = useState<CouponDrawerState>(null);
  const q = useQuery({ queryKey: PROMO_KEY, queryFn: () => api.get<Overview>("/promotions"), enabled: !!me && allowed });
  if (me && !allowed) return <NoAccess need={["owner", "finance"]} mine={rolesOf(me)} />;
  const data = q.data;
  return (
    <>
      <PageHead title={t("title")} desc={t("desc")} />
      <Tabs
        label={t("tabs.label")}
        value={tab}
        onChange={setTab}
        tabs={(["plans", "campaigns", "announce", "history"] as const).map((v) => ({ value: v, label: t(`tabs.${v}`) }))}
      />
      {tab === "plans" && (
        <>
          {data?.pendingPrices.length ? (
            <Notice tone="warn" title={t("pendingTitle", { count: data.pendingPrices.length })}>
              {data.pendingPrices.map((p) => (
                <div key={p.id} className="small">
                  {t("pendingItem", {
                    plan: PLAN_NAME[p.plan] ?? p.plan,
                    price: p.monthlySatang === null ? "—" : `${fmt.money(p.monthlySatang)} ${t("plans.perMonth")}`,
                    name: p.requestedBy,
                    time: fmt.dateTime(p.createdAt),
                    reason: p.reason,
                  })}
                </div>
              ))}
            </Notice>
          ) : null}
          {q.isPending ? (
            <TableSkeleton rows={3} cols={5} />
          ) : q.error ? (
            <ErrorBlock error={q.error} retry={() => void q.refetch()} />
          ) : (
            <>
              <Plans plans={q.data.plans} canWrite={allowed} onEdit={setEditing} />
              <Coupons data={q.data} canWrite={allowed} onCreate={() => setCouponDrawer({ kind: "create" })} onOpen={setCouponDrawer} />
            </>
          )}
        </>
      )}
      {tab === "campaigns" && (
        <section className="card">
          <Empty title={t("campaigns.title")} description={t("campaigns.desc")} />
        </section>
      )}
      {tab === "announce" && <AnnouncementsPage embedded />}
      {tab === "history" && <PriceHistory />}
      {editing && <PlanDrawer key={editing.code} plan={editing} onClose={() => setEditing(null)} />}
      {couponDrawer && (
        <CouponDrawer
          key={couponDrawer.kind === "create" ? "create" : `${couponDrawer.kind}-${couponDrawer.coupon.id}`}
          initial={couponDrawer.kind === "create" ? undefined : formOf(couponDrawer.coupon, couponDrawer.kind === "copy")}
          editing={couponDrawer.kind === "edit" ? couponDrawer.coupon : undefined}
          onClose={() => setCouponDrawer(null)}
        />
      )}
    </>
  );
}

function Plans({ plans, canWrite, onEdit }: { plans: PlanRow[]; canWrite: boolean; onEdit: (p: PlanRow) => void }) {
  const t = useTranslations("promo.plans");
  const fmt = useFmt();
  return (
    <>
      <section aria-label={t("label")} className="promo-plans">
        {plans.map((p) => (
          <article key={p.code} className="card promo-plan" aria-label={p.name}>
            <div className="row">
              <b>{p.name}</b>
              {!p.listed && <Pill>{t("hidden")}</Pill>}
              {!p.openForSignup && <Pill tone="warn">{t("closed")}</Pill>}
            </div>
            <div>
              {p.monthlySatang === null ? (
                <span className="promo-plan-price">{t("quote")}</span>
              ) : (
                <>
                  <span className="promo-plan-price">{fmt.money(p.monthlySatang)}</span> {p.monthlySatang > 0 && <span className="muted small">{t("perMonth")}</span>}
                </>
              )}
            </div>
            <ul>
              <li>{p.seatLimit === null ? t("seatsUnlimited") : t("seats", { count: p.seatLimit })}</li>
              <li>{p.projects === null ? t("projectsUnlimited") : t("projects", { count: p.projects })}</li>
              <li>{p.storageGbPerMember === null ? t("storageContract") : t("storage", { count: p.storageGbPerMember })}</li>
            </ul>
            <div className="promo-plan-foot">
              <span className="muted">{t("customers")}</span>
              <b className="num">{fmt.num(p.customers)}</b>
              {p.grandfathered > 0 && <span className="muted">· {t("grandfathered", { count: p.grandfathered })}</span>}
              {canWrite && (
                <Button size="small" className="push-end" aria-label={t("editLabel", { plan: p.name })} onClick={() => onEdit(p)}>
                  {t("edit")}
                </Button>
              )}
            </div>
          </article>
        ))}
      </section>
      <p className="muted small">{t("note")}</p>
    </>
  );
}

function Coupons({ data, canWrite, onCreate, onOpen }: { data: Overview; canWrite: boolean; onCreate: () => void; onOpen: (a: CouponAction) => void }) {
  const t = useTranslations("promo.coupons");
  const fmt = useFmt();
  const text = useCouponText();
  const create = canWrite && (
    <Button variant="primary" onClick={onCreate}>
      <Plus size={16} /> {t("create")}
    </Button>
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{t("title")}</h2>
        <span className="card-sub">{t("summary", { active: data.summary.activeCoupons, amount: fmt.money(data.summary.discountThisMonthSatang) })}</span>
        <span className="push-end">{create}</span>
      </div>
      {!data.coupons.length ? (
        <Empty title={t("empty")} description={t("emptyDesc")} action={create} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("col.code")}</th>
                <th scope="col">{t("col.off")}</th>
                <th scope="col">{t("col.duration")}</th>
                <th scope="col">{t("col.plans")}</th>
                <th scope="col" className="num">
                  {t("col.used")}
                </th>
                <th scope="col">{t("col.expires")}</th>
                <th scope="col">{t("col.status")}</th>
                <th scope="col" className="num" title={t("retentionHint")}>
                  {t("col.retention")}
                </th>
                <th scope="col">
                  <span className="sr-only">{t("col.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.coupons.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="cell-main mono">{c.code}</span>
                    {c.description && (
                      <span className="cell-sub" style={{ display: "block" }}>
                        {c.description}
                      </span>
                    )}
                  </td>
                  <td className="num">{text.off(c)}</td>
                  <td>{text.durationCell(c)}</td>
                  <td>{text.plans(c.planCodes)}</td>
                  <td className="num">
                    {c.used} / {c.maxRedemptions ?? t("unlimited")}
                    {c.pending > 0 && (
                      <span className="cell-sub" style={{ display: "block" }}>
                        {t("pendingUse", { count: c.pending })}
                      </span>
                    )}
                  </td>
                  <td className="num">{c.expiresOn ? text.day(c.expiresOn) : t("noExpiry")}</td>
                  <td>
                    <span className="row">
                      <Pill tone={STATE_TONE[c.state]}>{t(`state.${c.state}`)}</Pill>
                      {c.pendingApproval && <Pill tone="inf">{t("awaitingApproval")}</Pill>}
                    </span>
                  </td>
                  <td className="num" title={t("retentionHint")}>
                    {c.retention.rate === null ? (
                      "—"
                    ) : (
                      <>
                        {Math.round(c.retention.rate * 100)}%
                        <span className="cell-sub" style={{ display: "block" }}>
                          {t("retentionSub", { kept: c.retention.kept, eligible: c.retention.eligible })}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    <CouponMenu coupon={c} canWrite={canWrite} onOpen={onOpen} />
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
