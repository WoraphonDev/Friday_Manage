"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { OPS_UNAUTHORIZED } from "@/lib/api";
import { createQueryClient } from "@/lib/query";
import { ToastProvider } from "./ui";

/**
 * session หมด (401) นอกโครงหน้า → ล้าง cache แล้วไปหน้า Login
 * ในโครงหน้า (AppShell) ใช้หน้าต่าง "เซสชันหมดอายุ" (S3) แทน เพื่อทำต่อจากหน้าเดิมได้ · AppShell ใส่ data-ops-shell ไว้ที่ body
 */
function Unauthorized() {
  const router = useRouter();
  const cache = useQueryClient();
  useEffect(() => {
    const go = () => {
      if (document.body.dataset.opsShell === "1") return;
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
