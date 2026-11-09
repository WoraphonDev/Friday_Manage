import { Suspense } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { LoadingState } from "@/components/ui";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  // AppShell อ่าน searchParams (breadcrumb / เมนูที่เลือก) จึงต้องอยู่ใน Suspense ตอน prerender
  return (
    <Suspense fallback={<LoadingState />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
