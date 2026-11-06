"use client";

import { NotFound } from "@/components/ui";
import { Checkout } from "./checkout";
import { BillingOverviewPage } from "./overview";

/** /billing = แพ็กเกจ & Billing · /billing/checkout = ชำระเงิน (R2) */
export function Billing({ ws, section, plan, cycle }: { ws: string; section?: string; plan?: string; cycle?: string }) {
  if (!section) return <BillingOverviewPage ws={ws} />;
  if (section === "checkout") return <Checkout ws={ws} initialPlan={plan} initialCycle={cycle} />;
  return <NotFound />;
}
