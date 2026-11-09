import type { Metadata } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { Providers } from "@/components/providers";
import { DEFAULT_THEME, THEME_COOKIE, THEME_SCRIPT, isThemePref } from "@/features/theme-switch/theme";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/500.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-sans-thai/700.css";
// wordmark ของโลโก้ใช้ Nunito เฉพาะน้ำหนัก 900 และตัวละติน
import "@fontsource/nunito/latin-900.css";
import "@/styles/globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.app");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("description"),
  };
}
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locale, allMessages, jar] = await Promise.all([getLocale(), getMessages(), cookies()]);
  const savedTheme = jar.get(THEME_COOKIE)?.value;
  const themePref = isThemePref(savedTheme) ? savedTheme : DEFAULT_THEME;
  return (
    // data-theme ตั้งโดย THEME_SCRIPT ก่อนวาดหน้า (ค่า "ตามระบบ" รู้ได้เฉพาะฝั่ง browser)
    // จึงต้องปิดคำเตือน hydration ของ <html> เฉพาะ attribute นี้
    <html lang={locale} data-theme-pref={themePref} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider
          locale={locale}
          messages={allMessages}
          timeZone="Asia/Bangkok"
        >
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
