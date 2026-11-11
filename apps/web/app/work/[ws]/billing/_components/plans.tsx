"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorState, Forbidden, LoadingState } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { ApiError, api } from "@/lib/api";
import type { PublicPlan } from "@/features/plan-limits";
import { PricingSection, type Cyc, type PlanCta } from "../../../../(public)/_components/pricing";
import type { BillingOverview } from "./types";
import styles from "./billing.module.css";

// ช่องทางติดต่อฝ่ายขายเดียวกับหน้า /pricing
const SALES_URL = process.env.NEXT_PUBLIC_SALES_URL ?? "/signup?plan=enterprise";

/**
 * เปรียบเทียบแพ็กเกจในระบบ (/work/:ws/billing/plans) · เดิมปุ่มพาไป /pricing ของหน้าเว็บสาธารณะ ซึ่งไม่มี Sidebar
 * และปุ่มพาไปสมัครใหม่ (ผู้ใช้แจ้ง 2026-11-11) · ที่นี่ปุ่มไปหน้าชำระเงินของ Workspace นี้แทน
 */
export function BillingPlansPage({ ws }: { ws: string }) {
  const t = useTranslations("saas-pages.pricing");
  const { workspace } = useWorkspace();
  const canBill = workspace.role === "owner" || workspace.role === "admin";
  const base = `/work/${encodeURIComponent(ws)}/billing`;
  const overview = useQuery({ queryKey: ["billing", ws], queryFn: () => api.get<BillingOverview>(`/w/${encodeURIComponent(ws)}/billing`), enabled: canBill });

  if (!canBill) return <div className={styles.page}><Forbidden /></div>;
  if (overview.error)
    return <div className={styles.page}>{overview.error instanceof ApiError && overview.error.status === 403 ? <Forbidden /> : <ErrorState error={overview.error} retry={() => overview.refetch()} />}</div>;
  if (overview.isPending) return <div className={styles.page}><LoadingState /></div>;

  const sub = overview.data.subscription;
  const ctaFor = (p: PublicPlan, cycle: Cyc): PlanCta => {
    if (p.contactSales) return { label: t("contact"), href: SALES_URL };
    const isCurrent = p.code === sub.planCode;
    // ใช้อยู่และจ่ายแล้วรอบเดียวกัน = ไม่มีอะไรให้ทำ · ช่วงทดลอง / ค้างชำระ / เปลี่ยนรอบบิล ยังไปชำระเงินได้
    if (isCurrent && (p.code === "free" || (sub.status === "active" && sub.cycle === cycle))) return { label: t("inApp.current") };
    // ลงไป Free = ยกเลิกแพ็กเกจ ซึ่งอยู่ในหน้า Billing (มีแบบสอบถามก่อนยกเลิก)
    if (p.code === "free") return { label: t("inApp.toFree"), href: base };
    return { label: t(isCurrent ? "inApp.payCurrent" : "inApp.choose"), href: `${base}/checkout?plan=${p.code}&cycle=${cycle}` };
  };

  return (
    <div className={styles.page}>
      <PricingSection heading="h1" ctaFor={ctaFor} />
    </div>
  );
}
