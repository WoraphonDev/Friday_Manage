"use client";

import { NotFound } from "@/components/ui";
import { BillingOverviewPage } from "./overview";

/** /billing = แพ็กเกจ & Billing · หน้าชำระเงินย้ายไป /billing/checkout (W22 · src/features/checkout) */
export function Billing({ ws, section }: { ws: string; section?: string }) {
  if (!section) return <BillingOverviewPage ws={ws} />;
  return <NotFound />;
}
