"use client";

import { NotFound } from "@/components/ui";
import { BillingOverviewPage } from "./overview";
import { BillingPlansPage } from "./plans";

/** /billing = แพ็กเกจ & Billing · /billing/plans = เปรียบเทียบแพ็กเกจในระบบ · หน้าชำระเงินอยู่ที่ /billing/checkout (W22 · src/features/checkout) */
export function Billing({ ws, section }: { ws: string; section?: string }) {
  if (!section) return <BillingOverviewPage ws={ws} />;
  if (section === "plans") return <BillingPlansPage ws={ws} />;
  return <NotFound />;
}
