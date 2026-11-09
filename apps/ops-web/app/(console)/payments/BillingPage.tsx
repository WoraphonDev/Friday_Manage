"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { hasAny } from "@/components/access";
import { PageHead, Tabs } from "@/components/kit";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useMe } from "@/lib/query";
import { exceptionsKey, VerifyTab } from "./_parts/Verify";
import { AccountantExport, IncomingTab, InvoicesTab, OverdueTab, RefundsSummaryTab, RevenueTab, TaxTab } from "./_parts/Tabs";

const TABS = ["verify", "incoming", "invoices", "overdue", "tax", "refunds", "revenue"] as const;
type Tab = (typeof TABS)[number];

/** หน้า 4 · รายได้และการชำระเงิน 7 แท็บ (Billing.dc.html) · เปิดให้ Owner การเงิน ผู้ตรวจ (ทำรายการเฉพาะการเงิน) */
export function BillingPage() {
  const t = useTranslations("money");
  const params = useSearchParams();
  const router = useRouter();
  const me = useMe().data;
  const tab: Tab = (TABS as readonly string[]).includes(params?.get("tab") ?? "") ? (params!.get("tab") as Tab) : "verify";
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exc = useQuery({ queryKey: exceptionsKey, queryFn: () => api.get<{ items: unknown[] }>("/payments/exceptions") });
  const over = useQuery({ queryKey: ["ops", "overdue"], queryFn: () => api.get<{ items: unknown[] }>("/overdue") });
  const finance = hasAny(me, "finance");
  return (
    <>
      <PageHead
        title={t("title")}
        desc={t("desc")}
        actions={
          <>
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
        }
      />
      <Tabs
        label={t("title")}
        value={tab}
        onChange={(v) => router.replace(`/payments?tab=${v}`)}
        tabs={TABS.map((v) => ({ value: v, label: t(`tabs.${v}`, { n: v === "verify" ? (exc.data?.items.length ?? 0) : (over.data?.items.length ?? 0) }) }))}
      />
      {tab === "verify" && <VerifyTab />}
      {tab === "incoming" && <IncomingTab />}
      {tab === "invoices" && <InvoicesTab creating={creating} onCreatingChange={setCreating} />}
      {tab === "overdue" && <OverdueTab />}
      {tab === "tax" && <TaxTab />}
      {tab === "refunds" && <RefundsSummaryTab />}
      {tab === "revenue" && <RevenueTab />}
      {exporting && <AccountantExport onClose={() => setExporting(false)} />}
    </>
  );
}
