"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PlanLimitHost } from "@/features/plan-limits";
import { ConfirmHost } from "./confirm-host";
import { API_UNAUTHORIZED } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { FloatingNotice, ToastProvider } from "./ui";

function ApiEvents() {
  const router = useRouter();
  const cache = useQueryClient();
  const t = useTranslations("common");
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    function unauthorized() {
      cache.clear();
      router.replace(
        `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`,
      );
    }
    const connection = () => setOffline(!navigator.onLine);
    connection();
    window.addEventListener(API_UNAUTHORIZED, unauthorized);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener(API_UNAUTHORIZED, unauthorized);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, [cache, router]);
  return (
    <>
      {offline && (
        <FloatingNotice>
          <span>{t("states.offline")}</span>
        </FloatingNotice>
      )}
      {/* 402 → Dialog ของ Q2 แยกตามชนิดขีดจำกัด (W19) */}
      <PlanLimitHost />
      <ConfirmHost />
    </>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ApiEvents />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
