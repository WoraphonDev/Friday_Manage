"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { OPS_UNAUTHORIZED } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { ToastProvider } from "./ui";

/** session หมด / ถูกลบพนักงาน (401) → ล้าง cache ข้อมูลลูกค้าแล้วไปหน้า Login */
function Unauthorized() {
  const router = useRouter();
  const cache = useQueryClient();
  useEffect(() => {
    const go = () => {
      cache.clear();
      router.replace("/login");
    };
    window.addEventListener(OPS_UNAUTHORIZED, go);
    return () => window.removeEventListener(OPS_UNAUTHORIZED, go);
  }, [cache, router]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Unauthorized />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
