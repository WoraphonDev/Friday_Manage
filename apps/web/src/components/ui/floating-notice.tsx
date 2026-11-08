"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * แจ้งผลการกระทำ (ย้ายการ์ด, ส่งรายงาน, ออฟไลน์ ฯลฯ) เป็นกล่องเล็กมุมขวาล่าง
 * วางในกอง toast (.toast-region) จึงซ้อนต่อกันไม่บังกัน และไม่ดันเนื้อหาหน้าให้กระโดด
 */
export function FloatingNotice({
  tone = "info",
  className,
  children,
}: {
  tone?: "info" | "error";
  className?: string;
  children: ReactNode;
}) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => setHost(document.querySelector(".toast-region") ?? document.body), []);
  if (!host) return null;
  return createPortal(
    <div
      className={cn("floating-notice", tone === "error" && "floating-notice-error", host === document.body && "floating-notice-alone", className)}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>,
    host,
  );
}
