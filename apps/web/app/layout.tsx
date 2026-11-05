import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { Providers } from "@/components/providers";
import { messages } from "@/i18n/messages";
import "@fontsource/ibm-plex-sans-thai/400.css";
import "@fontsource/ibm-plex-sans-thai/500.css";
import "@fontsource/ibm-plex-sans-thai/600.css";
import "@fontsource/ibm-plex-sans-thai/700.css";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: {
    default: messages.common.app.name,
    template: `%s · ${messages.common.app.name}`,
  },
  description: messages.common.app.description,
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const allMessages = await getMessages();
  return (
    <html lang="th">
      <body>
        <NextIntlClientProvider
          locale="th"
          messages={allMessages}
          timeZone="Asia/Bangkok"
        >
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
