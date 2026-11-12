"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useIsMobile } from "@/lib/use-mobile";
import { type NpsAsk, NpsPrompt } from "@/features/nps/NpsPrompt";
import { type Role, spotlightKey, type WhatsNewItem } from "./api";
import { Spotlight } from "./Spotlight";

import { WhatsNewFullScreen } from "./WhatsNew";

export { WhatsNewButton, WhatsNewMenuItem } from "./WhatsNew";

/** หลังหน้าโหลดเสร็จกี่มิลลิวินาทีจึงแสดง Spotlight / NPS (U2) */
const DELAY_MS = 3000;
/** ยังไม่ว่าง (กำลังพิมพ์ / มี Dialog หรือ Drawer เปิด) ลองใหม่ทุกกี่มิลลิวินาที */
const RETRY_MS = 2000;
const SESSION_KEY = "friday:session-start";

/** เวลาที่เริ่มใช้แอปในแท็บนี้ (เงื่อนไข "มือถือใช้งานไม่ถึง 2 นาที") · อ่าน storage ไม่ได้ = นับจากตอนนี้ */
function sessionSeconds() {
  let start = Date.now();
  try {
    const saved = Number(sessionStorage.getItem(SESSION_KEY));
    if (saved > 0) start = saved;
    else sessionStorage.setItem(SESSION_KEY, String(start));
  } catch {
    /* ไม่มี storage */
  }
  return Math.max(0, Math.round((Date.now() - start) / 1000));
}

/** ไม่แสดงขณะพิมพ์ เปิด Drawer งาน หรือมี Dialog / Popover อื่นอยู่ (กติกากันรบกวนของ U2 / U3) */
function busy(issueOpen: boolean) {
  if (issueOpen || typeof document === "undefined") return issueOpen;
  const el = document.activeElement as HTMLElement | null;
  const typing = !!el && (el.matches("input, textarea, select") || el.isContentEditable);
  return typing || !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}

type Phase = "wait" | "spotlight" | "nps" | "done";

/**
 * ตัวจัดคิว Spotlight (U2) และ NPS (U3) ของ WorkspaceShell: แสดงได้ทีละอย่าง · Spotlight ก่อน
 * มี Spotlight = ไม่ถาม NPS ใน session นี้ (API ไม่ถามในวันที่เห็น Spotlight ด้วย) · เรียก nps-prompt เมื่อพร้อมแสดงจริงเท่านั้น (API บันทึกว่าถามแล้ว)
 * วันแรกที่สมัครไม่มี Spotlight (API) ให้ Onboarding ทำงานก่อน · Guest ไม่เรียก API
 * วางหน้าเต็มจอของมีอะไรใหม่บนมือถือไว้ที่นี่ด้วย (อยู่นอกเมนู ☰ ที่ปิดตัวเองเมื่อกด)
 */
export function EngagementPrompts(props: { ws: string; role: Role; delayMs?: number }) {
  // useSearchParams ต้องอยู่ใต้ Suspense (หน้าที่ prerender ได้)
  return props.role === "guest" ? null : (
    <>
      <WhatsNewFullScreen ws={props.ws} role={props.role} />
      <Suspense fallback={null}>
        <Prompts key={props.ws} {...props} />
      </Suspense>
    </>
  );
}

function Prompts({ ws, delayMs = DELAY_MS }: { ws: string; role: Role; delayMs?: number }) {
  const mobile = useIsMobile();
  const params = useSearchParams();
  // อ่านค่าล่าสุดผ่าน ref: เปิด / ปิด Drawer ระหว่างรอไม่ทำให้เริ่มนับใหม่หรือเรียก nps-prompt ซ้ำ
  const issueOpen = useRef(false);
  issueOpen.current = !!params.get("issue");
  const isMobile = useRef(mobile);
  isMobile.current = mobile;
  const [phase, setPhase] = useState<Phase>("wait");
  const [prompt, setPrompt] = useState<NpsAsk | null>(null);
  const spot = useQuery({
    queryKey: spotlightKey(ws),
    queryFn: () => api.get<{ item: WhatsNewItem | null }>(`/me/spotlight?workspace=${encodeURIComponent(ws)}`),
    retry: false,
    staleTime: Infinity,
  });
  const settled = spot.isSuccess || spot.isError;

  useEffect(() => {
    if (phase !== "wait" || !settled) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const askNps = async () => {
      try {
        const q = new URLSearchParams({ workspace: ws, ...(isMobile.current ? { mobile: "true", sessionSeconds: String(sessionSeconds()) } : {}) });
        const r = await api.get<NpsAsk | { ask: false; reason: string }>(`/me/nps-prompt?${q}`);
        if (cancelled) return;
        if (r.ask) {
          setPrompt(r);
          setPhase("nps");
        } else if (r.reason === "short_mobile") {
          // มือถือใช้งานยังไม่ถึง 2 นาที: ถามใหม่เมื่อครบ (ยังไม่นับว่าถาม)
          timer = setTimeout(() => void askNps(), Math.max(RETRY_MS, (120 - sessionSeconds()) * 1000 + 500));
        } else setPhase("done");
      } catch {
        // ล้มเหลวเงียบ ๆ ไม่บังงาน
        if (!cancelled) setPhase("done");
      }
    };
    const tick = () => {
      if (cancelled) return;
      if (busy(issueOpen.current)) {
        timer = setTimeout(tick, RETRY_MS);
        return;
      }
      if (spot.data?.item) setPhase("spotlight");
      else void askNps();
    };
    timer = setTimeout(tick, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, settled, spot.data, ws, delayMs]);

  if (phase === "spotlight" && spot.data?.item) return <Spotlight ws={ws} item={spot.data.item} onClose={() => setPhase("done")} />;
  if (phase === "nps" && prompt) return <NpsPrompt ws={ws} prompt={prompt} onClose={() => setPhase("done")} />;
  return null;
}
