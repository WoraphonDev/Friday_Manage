// ส่ง Error ไป GlitchTip (ใช้ Sentry SDK) · ต้อง import ก่อนโมดูลอื่นเพื่อให้ SDK ครอบ http / express ได้
// ไม่ตั้ง SENTRY_DSN = ปิด (เครื่องพัฒนา, CI, test) โดยไม่ต้องแก้โค้ด
import * as Sentry from '@sentry/node';
import { ConsoleLogger } from '@nestjs/common';

export const sentryEnabled = !!process.env.SENTRY_DSN;

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.APP_VERSION,
    // GlitchTip ไม่รองรับ performance tracing เต็มรูปแบบ · เก็บเฉพาะ Error ลดค่าใช้จ่าย
    tracesSampleRate: 0,
    // SDK รุ่นนี้ไม่ส่งข้อมูลส่วนบุคคล (cookie, IP, body) เป็นค่าเริ่มต้น · ใช้ requestId ในข้อความแทน
  });
}

/**
 * ErrorFilter กลางเขียน 5xx ผ่าน Logger ของ Nest (พร้อม requestId และ stack) ไม่ throw ต่อ
 * จึงส่งต่อจาก Logger แทนการแก้ filter · ระดับ warn ลงไปไม่ส่ง
 */
export class SentryLogger extends ConsoleLogger {
  override error(message: unknown, ...rest: unknown[]) {
    super.error(message, ...(rest as []));
    if (!sentryEnabled) return;
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    if (message instanceof Error) Sentry.captureException(message, { tags: { context } });
    else Sentry.captureMessage(String(message), { level: 'error', tags: { context } });
  }
}

/** ส่งที่ค้างก่อนปิดโปรเซส (ECS ส่ง SIGTERM ตอน deploy) */
export async function flushSentry() {
  if (sentryEnabled) await Sentry.flush(2000);
}
