import { render, type RenderOptions } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { messages } from "@/i18n/messages";
import { createQueryClient } from "@/lib/query";
import { ToastProvider } from "@/components/ui";

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & { messages?: Record<string, unknown> },
) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale="th"
        messages={{ ...messages, ...options?.messages }}
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
