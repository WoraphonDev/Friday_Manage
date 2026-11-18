"use client";

/*
 * การเคลื่อนไหวตอนเข้าสู่ระบบ ชุดเดียวกับแอปลูกค้า (apps/web › app/(auth)/_components/shared.tsx · ผู้ใช้ขอให้เหมือนกัน 2026-11-18)
 * ปุ่มระหว่างรอเป็นไทล์ 4 สีกระโดด → สำเร็จเป็นปุ่มเขียวพร้อมเครื่องหมายถูก → ฟอร์มเลื่อนออก → หน้าจอสำเร็จ (logo ประกอบตัว + แถบวิ่งเต็ม) → เปลี่ยนหน้า
 * แก้ที่หนึ่งให้แก้อีกที่ด้วย
 */
import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { motionDisabled } from "@/lib/motion";
import { Button } from "@/components/ui";

/** ปุ่มเขียวค้างให้เห็นเครื่องหมายถูกวาดจบ แล้วจึงเปลี่ยนเป็นหน้าจอสำเร็จ */
export const SUBMIT_DONE_MS = 650;
/** แถบในหน้าจอสำเร็จเต็มเมื่อ 0.45 + 1.6 วินาที (ตรงกับ .auth-success-bar) แล้วจึงเปลี่ยนหน้า */
export const LOGIN_SUCCESS_MS = 2050;

export const motionPause = (ms: number) => (motionDisabled() ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));

/** ฟอร์มเลื่อนออกทางซ้ายก่อนขึ้นหน้าจอสำเร็จ */
export async function slideOut(element: HTMLElement | null) {
  if (!element || motionDisabled() || !element.animate) return null;
  const animation = element.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateX(-28px)" },
    ],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  );
  await animation.finished.catch(() => undefined);
  return animation;
}

/** ฟอร์มสั่นเมื่อรหัสผิด */
export function shake(element: HTMLElement | null) {
  if (!element || motionDisabled() || !element.animate) return;
  element.animate([{ transform: "none" }, { transform: "translateX(-8px)" }, { transform: "translateX(7px)" }, { transform: "translateX(-4px)" }, { transform: "none" }], { duration: 380, easing: "ease-out" });
}

export function SubmitButton({
  busy,
  done,
  disabled,
  busyLabel,
  children,
  type = "submit",
  variant = "primary",
  onClick,
}: {
  busy: boolean;
  done?: boolean;
  disabled?: boolean;
  busyLabel: string;
  children: ReactNode;
  type?: "submit" | "button";
  variant?: "primary" | "secondary";
  onClick?: () => void;
}) {
  const state = done ? "done" : busy ? "busy" : "idle";
  return (
    <Button type={type} variant={variant} className="auth-submit" data-state={state} aria-busy={busy || undefined} disabled={busy || done || disabled} onClick={onClick}>
      <span className="auth-submit-label">{children}</span>
      <span className="auth-submit-busy" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="auth-submit-done" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M4.5 10.5 8.5 14l7-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {busy && <span className="sr-only">{busyLabel}</span>}
    </Button>
  );
}

/* ไทล์ 4 ชิ้นบินจากมุมเข้ามาประกอบเป็น logo แล้วเด้งทีละชิ้น (เขียว → เหลือง → ม่วง → ชมพู) · สีแบรนด์ไม่เปลี่ยนตามธีม */
const LOADER_TILES = [
  { x: 3, y: 4, fill: "#54ca94", from: "-14px, -14px", spin: "-90deg", pop: 0 },
  { x: 20, y: 4, fill: "#ffd66d", from: "14px, -14px", spin: "90deg", pop: 0.2 },
  { x: 3, y: 21, fill: "#ff7896", from: "-14px, 14px", spin: "90deg", pop: 0.6 },
  { x: 20, y: 21, fill: "#a67cea", from: "14px, 14px", spin: "-90deg", pop: 0.4 },
];

export function FridayLoader({ className }: { className?: string }) {
  return (
    <svg className={clsx("auth-loader", className)} viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <g transform="rotate(-9 18 18)">
        {LOADER_TILES.map((tile, index) => (
          <rect
            key={tile.fill}
            className="auth-loader-tile"
            style={{ "--from": tile.from, "--spin": tile.spin, "--enter-delay": `${0.2 + index * 0.08}s`, "--pop-delay": `${tile.pop}s` } as CSSProperties}
            x={tile.x}
            y={tile.y}
            width="13"
            height="13"
            rx="4.5"
            fill={tile.fill}
          />
        ))}
      </g>
    </svg>
  );
}

/** หน้าจอหลังเข้าสู่ระบบสำเร็จ */
export function LoginSuccess({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="auth-success" role="status">
      <FridayLoader />
      <div className="auth-success-text">
        <h1 className="page-title">{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      <div className="auth-success-bar" aria-hidden="true">
        <i />
      </div>
    </div>
  );
}
