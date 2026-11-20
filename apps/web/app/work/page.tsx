"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui";
import { destinationAfterLogin } from "../(auth)/_components/navigation";

/**
 * ปลายทางหลังเข้าสู่ระบบด้วย Google / Microsoft (API redirect กลับมาเป็นหน้าเต็ม)
 * หาเหมือนเข้าสู่ระบบด้วยรหัสผ่าน: Workspace แรก → ยังไม่มีไป Onboarding · ไม่งั้นลูกค้าใหม่ไปค้างที่หน้า Landing (/)
 * ยังไม่ได้เข้าสู่ระบบ: api ตอบ 401 แล้ว Providers พาไปหน้า Login
 */
export default function Page() {
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);

  const go = useCallback(() => {
    setError(null);
    destinationAfterLogin(null)
      .then((href) => router.replace(href))
      .catch(setError);
  }, [router]);

  useEffect(go, [go]);

  return error ? <ErrorState error={error} retry={go} /> : <LoadingState />;
}
