// Stripe.js โหลดจาก js.stripe.com ตอนเลือกชำระด้วยบัตรเท่านั้น (ข้อมูลบัตรไม่ผ่านเซิร์ฟเวอร์ของ Friday)
// ไม่ใช้แพ็กเกจ @stripe/stripe-js เพื่อไม่เพิ่ม dependency · ใช้เฉพาะส่วนที่หน้า Checkout เรียก

export interface StripeCardElement {
  mount(el: HTMLElement): void;
  destroy(): void;
  on(event: "change", handler: (e: { complete: boolean; error?: { message: string } }) => void): void;
}
export interface StripeLike {
  elements(options?: { locale?: string }): { create(type: "card", options?: Record<string, unknown>): StripeCardElement };
  confirmCardPayment(
    clientSecret: string,
    data: { payment_method: { card: StripeCardElement; billing_details?: { name?: string; email?: string } } },
  ): Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }>;
}

declare global {
  interface Window {
    Stripe?: (key: string) => StripeLike;
  }
}

export const STRIPE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
const SRC = "https://js.stripe.com/v3/";
let loading: Promise<StripeLike | null> | null = null;

/** คืน null เมื่อไม่ได้ตั้งกุญแจ (โหมดพัฒนาที่ API ใช้ FakeGateway) */
export function loadStripe(key = STRIPE_KEY): Promise<StripeLike | null> {
  if (!key || typeof window === "undefined") return Promise.resolve(null);
  if (window.Stripe) return Promise.resolve(window.Stripe(key));
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SRC;
    script.async = true;
    script.onload = () => (window.Stripe ? resolve(window.Stripe(key)) : reject(new Error("stripe_unavailable")));
    script.onerror = () => {
      loading = null;
      reject(new Error("stripe_unavailable"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
