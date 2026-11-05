"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { API_PLAN_LIMIT, API_UNAUTHORIZED, ApiError } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { Dialog, ToastProvider, buttonVariants } from "./ui";

function ApiEvents() {
  const router = useRouter();
  const cache = useQueryClient();
  const t = useTranslations("common");
  const [limit, setLimit] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    function unauthorized() {
      cache.clear();
      router.replace(
        `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`,
      );
    }
    function planLimit(event: Event) {
      setLimit((event as CustomEvent<ApiError>).detail);
    }
    const connection = () => setOffline(!navigator.onLine);
    connection();
    window.addEventListener(API_UNAUTHORIZED, unauthorized);
    window.addEventListener(API_PLAN_LIMIT, planLimit);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener(API_UNAUTHORIZED, unauthorized);
      window.removeEventListener(API_PLAN_LIMIT, planLimit);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, [cache, router]);
  const ws =
    typeof window === "undefined"
      ? undefined
      : window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];
  return (
    <>
      {offline && (
        <div className="notice" role="status">
          {t("states.offline")}
        </div>
      )}
      <Dialog
        open={!!limit}
        onOpenChange={() => setLimit(null)}
        title={t("plan.title")}
        description={limit?.message ?? t("plan.description")}
      >
        <div className="stack">
          {limit?.details.current !== undefined &&
            limit.details.limit !== undefined && (
              <p>
                {t("plan.usage", {
                  current: String(limit.details.current),
                  limit: String(limit.details.limit),
                })}
              </p>
            )}
          {ws && (
            <Link
              onClick={() => setLimit(null)}
              className={buttonVariants({ variant: "primary" })}
              href={`/w/${ws}/billing`}
            >
              {t("plan.view")}
            </Link>
          )}
        </div>
      </Dialog>
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
