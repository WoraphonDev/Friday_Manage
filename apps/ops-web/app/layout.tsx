import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { Providers } from "@/components/providers";
import { messages } from "@/i18n/messages";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/500.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-sans-thai/700.css";
import "@/styles/globals.css";
import "@/components/styles/tokens.css";
import "@/components/styles/ops.css";

export const metadata: Metadata = {
  title: messages.ops.app.name,
  // หลังบ้านภายใน: ไม่ให้ search engine เก็บ
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>
        <NextIntlClientProvider locale="th" messages={messages} timeZone="Asia/Bangkok">
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
