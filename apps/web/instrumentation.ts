// ส่ง Error ฝั่ง server ของ Next.js ไป GlitchTip (Sentry SDK) · ไม่ตั้ง SENTRY_DSN = ปิด
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.APP_VERSION,
    // GlitchTip เก็บเฉพาะ Error · ไม่เปิด tracing เพื่อลดค่าใช้จ่าย
    tracesSampleRate: 0,
  });
}

// Error ระหว่าง render / route handler ของ App Router
export const onRequestError = Sentry.captureRequestError;
