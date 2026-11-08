"use client";

import { useEffect, useState } from "react";

/** วาด QR จาก payload ของ PromptPay (EMVCo) เป็น SVG · โหลดไลบรารีเมื่อใช้จริงเท่านั้น */
export function useQrDataUrl(payload: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!payload) return;
    import("qrcode")
      .then((QR) => QR.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 }))
      .then((svg) => alive && setUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [payload]);
  return url;
}
