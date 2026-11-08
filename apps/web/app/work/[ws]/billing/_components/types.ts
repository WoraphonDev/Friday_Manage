// รูปแบบตาม API จริง: apps/api/src/billing (A29) และ apps/api/src/payments (A33) · เงินเป็นสตางค์
import type { Cycle, PaidPlan, PlanCode, SubscriptionStatus } from "@/features/plan-limits";

export type Method = "card" | "promptpay" | "transfer";
export type InvoiceStatus = "open" | "pending_review" | "paid" | "void";

export interface BillingProfile {
  companyName: string;
  taxId: string;
  branchType: "head" | "branch";
  branchNo: string | null;
  address: string;
  taxEmail: string;
  whtEnabled: boolean;
}

/** `GET w/billing` */
export interface BillingOverview {
  plan: { code: PlanCode; name: string };
  subscription: { status: SubscriptionStatus; cycle: Cycle; trialEndsAt: string | null; currentPeriodEnd: string | null; planCode: PlanCode };
  limits: { seats: number | null; projects: number | null; storage_bytes: number | null };
  profile: BillingProfile | null;
}

/** `GET w/billing/quote` */
export interface Quote {
  plan: PaidPlan;
  planName: string;
  cycle: Cycle;
  wht: boolean;
  subtotal: number;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  currentPlan: PlanCode;
}

/** `GET w/billing/invoices` · `invoices/:id` */
export interface Invoice {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  vat: number;
  total: number;
  whtAmount: number;
  amountDue: number;
  poNumber: string | null;
  status: InvoiceStatus;
  dueDate: string;
  paidAt: string | null;
  createdAt: string;
  method: Method | null;
  paymentStatus: "pending" | "pending_review" | "confirmed" | "rejected" | null;
  hasSlip: boolean;
  pdfUrl: string;
  taxDocument: { id: string; number: string; status: string; sentAt: string | null; pdfUrl: string } | null;
  whtCertificate: { id: string; status: string; uploadedAt: string } | null;
  whtDueBy: string | null;
}

/** `POST w/billing/checkout` */
export interface CheckoutResult {
  invoice: Omit<Invoice, "method" | "paymentStatus" | "hasSlip" | "pdfUrl" | "taxDocument" | "whtCertificate" | "whtDueBy">;
  payment: { id: string; method: Method; status: string; amount: number };
  card?: { clientSecret: string };
  promptpay?: { qrPayload: string; expiresAt: string };
  transfer?: { bank: string; accountNo: string; accountName: string; reference: string; dueDate: string; amount: number };
  replayed: boolean;
}
