// ส่ง Error ฝั่งเบราว์เซอร์ไป GlitchTip · DSN ฝังตอน build (NEXT_PUBLIC_*) · ไม่ตั้ง = ไม่โหลดการส่ง
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: 0,
    // ไม่บันทึกหน้าจอผู้ใช้ (Session Replay) เพราะมีข้อมูลงานของลูกค้า
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
