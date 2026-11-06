"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PlanLimitHost } from "@/features/plan-limits";
import { API_UNAUTHORIZED } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { ToastProvider } from "./ui";

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
        <div className="notice" role="status">
          {t("states.offline")}
        </div>
      )}
      {/* 402 → Dialog ของ Q2 แยกตามชนิดขีดจำกัด (W19) */}
      <PlanLimitHost />
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
