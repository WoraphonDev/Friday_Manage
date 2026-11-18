"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { PageHead, Tabs } from "@/components/kit";
import { MotionSwap } from "@/components/shell/page-enter";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { VerifyTab } from "./_parts/Verify";
import { AccountantExport } from "./_parts/Accounting";
import { TaxTab } from "./_parts/Tax";
import { IncomingTab, InvoicesTab, OverdueTab, RevenueTab } from "./_parts/Tabs";

type Tab = "verify" | "incoming" | "invoices" | "overdue" | "tax" | "revenue";
type Group = "verify" | "billing" | "accounting";

/**
 * หนึ่งเมนู หนึ่งหน้า (โครงหน้า Ops 18 พ.ย. 2569): เมนูซ้าย 3 รายการในกลุ่มเงินเคยพามาหน้าเดียวกันที่มี 7 แท็บ
 * ตอนนี้แต่ละเมนูเห็นเฉพาะแท็บของตัวเอง · ชื่อหน้าตรงกับเมนู · คืนเงินมีเมนูของตัวเอง (/refunds) จึงไม่มีแท็บซ้ำ
 */
const GROUPS: Record<Group, Tab[]> = {
  verify: ["verify", "incoming"],
  billing: ["invoices", "overdue", "tax"],
  accounting: ["revenue"],
};
const groupOf = (tab: Tab): Group => (Object.keys(GROUPS) as Group[]).find((g) => GROUPS[g].includes(tab))!;

/** หน้า 4 · เงิน (Billing.dc.html) · เปิดให้ Owner การเงิน ผู้ตรวจ (ทำรายการเฉพาะการเงิน) */
export function BillingPage() {
  const t = useTranslations("money");
  const tn = useTranslations("common.nav");
  const params = useSearchParams();
  const router = useRouter();
  const me = useMe().data;
  const asked = params?.get("tab") ?? "";
  // ลิงก์เดิม ?tab=refunds พาไปแท็บแรกของกรณีผิดปกติ (คืนเงินอยู่เมนูคืนเงินและอนุมัติ)
  const tab: Tab = (Object.values(GROUPS).flat() as string[]).includes(asked) ? (asked as Tab) : "verify";
  const group = groupOf(tab);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const over = useQuery({ queryKey: ["ops", "overdue"], queryFn: () => api.get<{ items: unknown[] }>("/overdue"), enabled: group === "billing" });
  const finance = hasAny(me, "finance");
  const tabs = GROUPS[group];
  return (
    <>
      <PageHead
        title={tn(group)}
        desc={t(`groups.${group}.desc`)}
        actions={
          group === "billing" ? (
            <>
              {/* ใบกำกับภาษีและ 50 ทวิ ส่งให้สำนักงานบัญชีด้วย จึงส่งออกจากหน้านี้ได้ (ปุ่มรอง) */}
              <Button onClick={() => setExporting(true)}>{t("export")}</Button>
              {finance && (
                <Button
                  variant="primary"
                  onClick={() => {
                    if (tab !== "invoices") router.replace("/payments?tab=invoices");
                    setCreating(true);
                  }}
                >
                  <Plus size={16} /> {t("create")}
                </Button>
              )}
            </>
          ) : group === "accounting" ? (
            <Button variant="primary" onClick={() => setExporting(true)}>
              {t("export")}
            </Button>
          ) : undefined
        }
      />
      {tabs.length > 1 && (
        <Tabs
          label={tn(group)}
          value={tab}
          onChange={(v) => router.replace(`/payments?tab=${v}`)}
          tabs={tabs.map((v) => ({ value: v, label: v === "verify" ? t("tabs.todo") : t(`tabs.${v}`, { n: over.data?.items.length ?? 0 }) }))}
        />
      )}
      {/* เปลี่ยนแท็บ (?tab=) ไม่เปลี่ยน route: เนื้อหาแท็บเคลื่อนเข้าแบบเปลี่ยนหน้า */}
      <MotionSwap key={tab} className="motion-stack">
        {tab === "verify" && <VerifyTab />}
        {tab === "incoming" && <IncomingTab />}
        {tab === "invoices" && <InvoicesTab creating={creating} onCreatingChange={setCreating} />}
        {tab === "overdue" && <OverdueTab />}
        {tab === "tax" && <TaxTab />}
        {tab === "revenue" && <RevenueTab />}
      </MotionSwap>
      {exporting && <AccountantExport onClose={() => setExporting(false)} />}
    </>
  );
}
