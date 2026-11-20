"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, Forbidden, LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { trackEvents } from "@/lib/track";
import type { PublicPlan } from "@/features/plan-limits";
import { CancelSurvey } from "@/features/checkout/CancelSurvey";
import { PricingSection, type Cyc, type PlanCta } from "../../../../(public)/_components/pricing";
import type { BillingOverview } from "./types";
import styles from "./billing.module.css";

// ช่องทางติดต่อฝ่ายขายเดียวกับหน้า /pricing
const SALES_URL = process.env.NEXT_PUBLIC_SALES_URL ?? "/contact-sales";

/**
 * ตารางเปรียบเทียบแพ็กเกจของ Workspace นี้ · ปุ่มของแต่ละแพ็กเกจไปหน้าชำระเงินของ Workspace (ไม่ใช่สมัครใหม่แบบหน้า /pricing)
 * ใช้ทั้งใน Dialog ของหน้า Billing (ผู้ใช้ขอ 2026-11-15) และหน้า /billing/plans สำหรับลิงก์ตรง
 */
export function PlansCompare({ ws, sub, heading = "h1", onToFree }: { ws: string; sub: BillingOverview["subscription"]; heading?: "h1" | "none"; onToFree: () => void }) {
  const t = useTranslations("saas-pages.pricing");
  const { workspace } = useWorkspace();
  const base = `/work/${encodeURIComponent(ws)}/billing`;
  // สัญญาณ Lead ของ Ops (O54): Workspace ทดลองที่เปิดดูราคา / กดติดต่อฝ่ายขาย Enterprise · API นับครั้งแรกของวันต่อคน
  useEffect(() => trackEvents(ws, [{ name: "pricing.viewed", props: { placement: heading === "h1" ? "billing_plans" : "billing_dialog" } }]), [ws, heading]);
  const ctaFor = (p: PublicPlan, cycle: Cyc): PlanCta => {
    if (p.contactSales) return { label: t("contact"), href: SALES_URL, onClick: () => trackEvents(ws, [{ name: "upgrade.prompt_clicked", props: { placement: "pricing", planFrom: sub.planCode, planTo: p.code } }]) };
    const isCurrent = p.code === sub.planCode;
    // ใช้อยู่และจ่ายแล้วรอบเดียวกัน = ไม่มีอะไรให้ทำ · ช่วงทดลอง / ค้างชำระ / เปลี่ยนรอบบิล ยังไปชำระเงินได้
    if (isCurrent && (p.code === "free" || (sub.status === "active" && sub.cycle === cycle))) return { label: t("inApp.current") };
    // ลงไป Free = ยกเลิกแพ็กเกจ (API ไม่ขาย Free ผ่าน checkout / scheduled-change) · เปิดหน้าต่างยกเลิกพร้อมแบบสอบถามเลย
    // เดิมลิงก์กลับหน้า Billing ที่เปิดอยู่ หน้าต่างจึงแค่ปิดเงียบ (ผู้ใช้แจ้ง 2026-11-20)
    if (p.code === "free") {
      if (sub.status === "canceled") return { label: t("inApp.freeOn", { date: formatDate(sub.currentPeriodEnd, "BE", true) }) };
      // API ให้เฉพาะ Owner ยกเลิกแพ็กเกจ
      if (workspace.role !== "owner") return { label: t("inApp.toFree"), hint: t("inApp.ownerOnly") };
      return { label: t("inApp.toFree"), onClick: onToFree };
    }
    return { label: t(isCurrent ? "inApp.payCurrent" : "inApp.choose"), href: `${base}/checkout?plan=${p.code}&cycle=${cycle}` };
  };
  return <PricingSection heading={heading} ctaFor={ctaFor} />;
}

/**
 * เปรียบเทียบแพ็กเกจในระบบ (/work/:ws/billing/plans) · เดิมปุ่มพาไป /pricing ของหน้าเว็บสาธารณะ ซึ่งไม่มี Sidebar
 * และปุ่มพาไปสมัครใหม่ (ผู้ใช้แจ้ง 2026-11-11) · ปุ่มในหน้า Billing เปิดเป็น Dialog แทนแล้ว หน้านี้คงไว้ให้ลิงก์เดิมยังเปิดได้
 */
export function BillingPlansPage({ ws }: { ws: string }) {
  const { workspace } = useWorkspace();
  const cache = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const canBill = workspace.role === "owner" || workspace.role === "admin";
  const overview = useQuery({ queryKey: ["billing", ws], queryFn: () => api.get<BillingOverview>(`/w/${encodeURIComponent(ws)}/billing`), enabled: canBill });

  if (!canBill) return <div className={styles.page}><Forbidden /></div>;
  if (overview.error)
    return <div className={styles.page}>{overview.error instanceof ApiError && overview.error.status === 403 ? <Forbidden /> : <ErrorState error={overview.error} retry={() => overview.refetch()} />}</div>;
  if (overview.isPending) return <div className={styles.page}><LoadingState /></div>;

  return (
    <div className={styles.page}>
      <PlansCompare ws={ws} sub={overview.data.subscription} onToFree={() => setCancelling(true)} />
      <CancelSurvey
        open={cancelling}
        onOpenChange={setCancelling}
        ws={ws}
        isOwner={workspace.role === "owner"}
        sub={overview.data.subscription}
        blockers={overview.data.freeBlockers}
        onCancelled={() => cache.invalidateQueries({ queryKey: ["billing", ws] })}
      />
    </div>
  );
}
