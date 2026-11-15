"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./primitives";
import { useToast } from "./toast";

export interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
}
function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const previous = useRef(false);
  if (open && !previous.current && typeof document !== "undefined")
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  previous.current = open;
  return (event: Event) => {
    event.preventDefault();
    opener.current?.focus();
  };
}
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  size,
}: OverlayProps & {
  /** wide = หน้าต่างสร้างงาน K1 (860 px ชิดบน 40 px) · medium = หน้าต่างฟอร์ม เช่น เชิญสมาชิก (680 px)
   *  xl = เนื้อหากว้างแบบหลายคอลัมน์ เช่น เปรียบเทียบแพ็กเกจ (1200 px ชิดบน 40 px) */
  size?: "wide" | "medium" | "xl";
}) {
  const t = useTranslations("common.app");
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content
          className={cn("dialog", size && `dialog-${size}`)}
          onCloseAutoFocus={returnFocus}
          {...(!description ? { "aria-describedby": undefined } : {})}
        >
          <div className="dialog-heading">
            <RadixDialog.Title>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")}>
                <X size={20} />
              </Button>
            </RadixDialog.Close>
          </div>
          {description && (
            <RadixDialog.Description className="muted">
              {description}
            </RadixDialog.Description>
          )}
          <div className="dialog-body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

const DRAWER_WIDTH_KEY = "friday:drawer-detail-width";
const DRAWER_MIN = 640;
/** ความกว้าง Drawer รายละเอียดงานที่ผู้ใช้ลากไว้ · เก็บเป็น CSS variable ให้ Drawer ซ้อน (Sub-task) กว้างเท่ากัน */
function applyDrawerWidth(width: number) {
  const max = Math.max(DRAWER_MIN, window.innerWidth - 48);
  const value = Math.round(Math.min(max, Math.max(DRAWER_MIN, width)));
  document.documentElement.style.setProperty("--drawer-detail-w", `${value}px`);
  return value;
}
function useStoredDrawerWidth(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    try {
      const saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
      if (saved > 0) applyDrawerWidth(saved);
    } catch {
      /* อ่าน storage ไม่ได้ใช้ค่าเริ่มต้น */
    }
  }, [enabled]);
}
/** ลากขอบซ้ายของ Drawer เพื่อขยายพื้นที่ทำงานไปทางซ้าย (ผู้ใช้ขอ 2026-11-07) */
function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("drawer-resizing");
  let width = 0;
  const move = (e: PointerEvent) => { width = applyDrawerWidth(window.innerWidth - e.clientX); };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("drawer-resizing");
    try { if (width) localStorage.setItem(DRAWER_WIDTH_KEY, String(width)); } catch { /* จำไม่ได้ก็ใช้ได้ใน session นี้ */ }
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  depth = 1,
  parentLabel,
  onBack,
  variant,
  bare = false,
}: OverlayProps & {
  depth?: 1 | 2;
  parentLabel?: string;
  onBack?: () => void;
  /** ขนาดตาม Canvas: detail = C/D, wide = K2 (920 px), create = B (640 px), panel = แผงช่วยเหลือ X4 (400 px) · ทุกแบบสูงเต็มจอ
   *  menu = เมนู Workspace ของมือถือ (W30): บนมือถือเป็นแผ่นล่างจอ · เปิดได้จากมือถือเท่านั้น */
  variant?: "detail" | "wide" | "create" | "panel" | "menu";
  /** เนื้อหามีแถบหัวของตัวเอง (ใช้ DrawerClose) · ชื่อ Drawer ยังอยู่สำหรับโปรแกรมอ่านหน้าจอ */
  bare?: boolean;
}) {
  const t = useTranslations("common.app");
  const returnFocus = useReturnFocus(open);
  // Drawer ซ้อน (Sub-task) ใช้ความกว้างเดียวกับชั้นแรก จึงมีขอบลากแค่ชั้นแรก
  const resizable = variant === "detail" && depth === 1;
  useStoredDrawerWidth(resizable && open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        {/* เงาคลุมเต็มจอทุกแบบ (ผู้ใช้ขอ 2026-11-11) เดิมเริ่มใต้หัวโปรเจกต์ทำให้แท็บดูต่อกับ Drawer */}
        <RadixDialog.Overlay className="overlay" />
        {resizable && (
          <div
            className="drawer-resize"
            data-drawer-resize=""
            role="separator"
            aria-orientation="vertical"
            aria-label={t("resizeDrawer")}
            title={t("resizeDrawer")}
            onPointerDown={startDrawerResize}
          />
        )}
        <RadixDialog.Content
          onPointerDownOutside={(event) => {
            // กดขอบลากไม่นับเป็นการกดนอก Drawer (ไม่ปิด)
            if ((event.target as HTMLElement | null)?.closest?.("[data-drawer-resize]")) event.preventDefault();
          }}
          className={cn(
            "drawer",
            depth === 2 && "drawer-nested",
            variant && `drawer-${variant}`,
            bare && "drawer-bare",
          )}
          onCloseAutoFocus={returnFocus}
          {...(!description ? { "aria-describedby": undefined } : {})}
        >
          {parentLabel && (
            <button
              type="button"
              className="drawer-parent"
              onClick={onBack ?? (() => onOpenChange(false))}
            >
              <ArrowLeft size={16} />
              {parentLabel}
            </button>
          )}
          {bare ? (
            <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          ) : (
            <div className="dialog-heading">
              <RadixDialog.Title>{title}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t("close")}>
                  <X size={20} />
                </Button>
              </RadixDialog.Close>
            </div>
          )}
          {description && (
            <RadixDialog.Description className="muted">
              {description}
            </RadixDialog.Description>
          )}
          <div className="drawer-body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** ปุ่มปิดสำหรับ Drawer แบบ bare ที่วางแถบหัวเอง */
export const DrawerClose = RadixDialog.Close;

export interface ActionSheetAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** ข้อความเล็กท้ายแถว เช่น คีย์ลัดหรือค่าปัจจุบัน */
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
/**
 * เมนูคำสั่งแบบ action sheet (ฐาน B ของต้นแบบมือถือ) · มือถือเป็นแผ่นล่างจอ + ปุ่มยกเลิก ตาม CSS ของ .dialog
 * ใช้แทน popover/dropdown เมื่อ useIsMobile() เป็นจริง · desktop ยังใช้เมนูเดิม (ถ้า render บน desktop จะเป็น Dialog ปกติ)
 * เลือกแล้วสั่งปิดแผ่นพร้อมเรียกคำสั่งในจังหวะเดียวกัน คำสั่งที่เปิด Dialog ต่อ (เช่น ยืนยันลบ) จึงแทนที่แผ่นนี้ ไม่ซ้อนกัน
 */
export function ActionSheet({
  actions,
  cancelLabel,
  ...props
}: Omit<OverlayProps, "children"> & { actions: ActionSheetAction[]; cancelLabel?: string }) {
  const t = useTranslations("common.app");
  return (
    <Dialog {...props}>
      <div className="action-sheet-list" role="group" aria-label={props.title}>
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className="action-sheet-item"
            data-destructive={action.destructive ? "" : undefined}
            disabled={action.disabled}
            onClick={() => {
              props.onOpenChange(false);
              action.onSelect();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
            {action.hint && <span className="action-sheet-hint">{action.hint}</span>}
          </button>
        ))}
      </div>
      <Button className="action-sheet-cancel" onClick={() => props.onOpenChange(false)}>
        {cancelLabel ?? t("cancel")}
      </Button>
    </Dialog>
  );
}

export function ConfirmDialog({
  onConfirm,
  undo,
  successMessage,
  confirmLabel,
  destructive = true,
  ...props
}: Omit<OverlayProps, "children"> & {
  onConfirm: () => void | Promise<void>;
  undo?: () => void | Promise<void>;
  successMessage?: string;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const t = useTranslations("common.app");
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setPending(true);
    setError("");
    try {
      await onConfirm();
      props.onOpenChange(false);
      if (successMessage) toast({ message: successMessage, undo });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("unknownError"));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      {...props}
      onOpenChange={(open) => {
        if (!pending) {
          setError("");
          props.onOpenChange(open);
        }
      }}
    >
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button disabled={pending} onClick={() => props.onOpenChange(false)}>
          {t("cancel")}
        </Button>
        <Button
          variant={destructive ? "danger" : "primary"}
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? t("saving") : (confirmLabel ?? t("confirm"))}
        </Button>
      </div>
    </Dialog>
  );
}
