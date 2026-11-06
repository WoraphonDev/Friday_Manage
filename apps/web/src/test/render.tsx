import { render, type RenderOptions } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { mergeMessages } from "@/features/locale-switch/merge-messages";
import { messages, messagesEn } from "@/i18n/messages";
import { createQueryClient } from "@/lib/query";
import { ToastProvider } from "@/components/ui";

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & {
    messages?: Record<string, unknown>;
    /** en = วางข้อความ EN ของ shell ทับไทย เหมือนที่ server ทำ (W21) */
    locale?: "th" | "en";
  },
) {
  const locale = options?.locale ?? "th";
  const base = locale === "en" ? mergeMessages(messages, messagesEn) : messages;
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale={locale}
        messages={{ ...base, ...options?.messages }}
        timeZone="Asia/Bangkok"
      >
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper, ...options }), client };
}
