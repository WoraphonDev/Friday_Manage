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
  /** O20 · ราคาแพ็กเกจก่อนส่วนลด (subtotal = หลังหักส่วนลด ก่อน VAT) */
  listPrice?: number;
  discount?: number;
  discounts?: QuoteDiscount[];
  /** โค้ดที่ส่งมาและใช้ได้ (ตัวพิมพ์ใหญ่) */
  coupon?: string | null;
  /** คูปองใช้ฟรี N เดือน: ใบนี้ไม่เสียเงิน ใช้ได้ N เดือน */
  freeMonths?: number | null;
  /** ลูกค้าเดิมได้ราคาเดิม (grandfathering) */
  grandfathered?: boolean;
}

export type CouponKind = "percent" | "amount" | "free_months";
/** ส่วนลดหนึ่งรายการในใบเสนอราคา · carried = ได้ต่อจากรอบก่อนโดยไม่ต้องใส่โค้ดอีก · cyclesLeft = รอบที่เหลือหลังใบนี้ (null = ตลอดไป) */
export interface QuoteDiscount {
  code: string;
  kind: CouponKind;
  value: number;
  amount: number;
  cyclesLeft: number | null;
  carried: boolean;
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
  /** O20 · ส่วนลดคูปองที่หักแล้ว */
  discount?: number;
  poNumber: string | null;
  status: InvoiceStatus;
  dueDate: string;
  paidAt: string | null;
  createdAt: string;
  method: Method | null;
  paymentStatus: "pending" | "pending_review" | "confirmed" | "rejected" | null;
  hasSlip: boolean;
  pdfUrl: string;
  taxDocument: { id: string; number: string; status: string; sentAt: string | null; issuedOn?: string | null; replacesId?: string | null; pdfUrl: string } | null;
  /** เวลาเงินเข้าจริง (โอน = เวลาที่ลูกค้าแจ้งในสลิป) */
  paymentPaidAt?: string | null;
  /** ใบลดหนี้ / ใบเพิ่มหนี้ของใบนี้ (หลังบ้านออก) */
  notes?: { kind: "credit" | "debit"; id: string; number: string; amount: number; issuedAt: string; pdfUrl: string }[];
  /** 50 ทวิ ล่าสุดของใบ · ไม่ผ่านแล้วเห็นสาเหตุ (rejectReason) · หักผ่าน e-WHT ไม่มีไฟล์ (ewhtRef) */
  whtCertificate: WhtCertificate | null;
  /** กำหนดส่ง 50 ทวิ = วันที่ชำระ + 30 วัน · ยังไม่ชำระ = null */
  whtDueBy: string | null;
  /** เลยกำหนดแล้วยังไม่ได้ส่ง (ยังส่งได้) · ไม่มีใน API รุ่นก่อน */
  whtOverdue?: boolean;
}

export type WhtStatus = "pending_review" | "confirmed" | "rejected" | "pending_ewht" | "uncollected";
export interface WhtCertificate {
  id: string;
  status: WhtStatus | string;
  /** upload = ไฟล์ · ewht = หักผ่าน e-Withholding Tax · ops = ทีมบันทึก (ไม่มีใน API รุ่นก่อน) */
  source?: "upload" | "ewht" | "ops";
  rejectReason?: string | null;
  ewhtRef?: string | null;
  uploadedAt: string;
}

export interface TransferInfo {
  bank: string;
  accountNo: string;
  accountName: string;
  reference: string;
  dueDate: string;
  amount: number;
}

/** `GET w/billing/invoices/:id` · ใบเดียวมีแพ็กเกจของใบ + บัญชีรับโอน (ใบโอนที่ยังไม่ปิด) */
export interface InvoiceDetail extends Invoice {
  plan: { code: PlanCode; name: string; cycle: Cycle } | null;
  transfer: TransferInfo | null;
}

/** `POST w/billing/checkout` */
export interface CheckoutResult {
  invoice: Omit<Invoice, "method" | "paymentStatus" | "hasSlip" | "pdfUrl" | "taxDocument" | "whtCertificate" | "whtDueBy" | "whtOverdue">;
  /** null = ไม่มียอดชำระ (คูปองใช้ฟรี / ส่วนลด 100%) ใบแจ้งหนี้ชำระแล้วทันที */
  payment: { id: string; method: Method; status: string; amount: number } | null;
  free?: boolean;
  card?: { clientSecret: string };
  promptpay?: { qrPayload: string; expiresAt: string };
  transfer?: TransferInfo;
  replayed: boolean;
}
