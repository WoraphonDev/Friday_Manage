"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { X } from "lucide-react";
import { Avatar, Button } from "./primitives";

/** ปุ่มลิงก์ใน Toast แจ้งเตือน (K4) · primary = ปุ่มขาวหลัก */
export interface ToastAction {
  label: string;
  href: string;
  primary?: boolean;
}
export interface ToastOptions {
  message: string;
  undo?: () => void | Promise<void>;
  duration?: number;
  /** มีผู้กระทำ = Toast แบบแจ้งเตือน K4 (รูป + ชื่อ + บรรทัดรอง + ปุ่ม) */
  actor?: { id: string; displayName: string };
  meta?: string;
  actions?: ToastAction[];
}
interface ToastItem extends ToastOptions {
  id: number;
  pending?: boolean;
}
const Context = createContext<(options: ToastOptions) => void>(() => undefined);
export const useToast = () => useContext(Context);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("common.app");
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);
  const push = useCallback(
    (options: ToastOptions) => {
      const id = ++nextId.current;
      setItems((previous) => [...previous, { ...options, id }]);
      timers.current.set(
        id,
        setTimeout(
          () => dismiss(id),
          options.duration ?? (options.undo ? 10000 : 5000),
        ),
      );
    },
    [dismiss],
  );
  useEffect(() => {
    const current = timers.current;
    return () => {
      for (const timer of current.values()) clearTimeout(timer);
    };
  }, []);
  async function undo(item: ToastItem) {
    clearTimeout(timers.current.get(item.id));
    setItems((previous) =>
      previous.map((row) =>
        row.id === item.id ? { ...row, pending: true } : row,
      ),
    );
    try {
      await item.undo?.();
      dismiss(item.id);
    } catch (error) {
      dismiss(item.id);
      push({
        message: error instanceof Error ? error.message : t("unknownError"),
      });
    }
  }
  return (
    <Context.Provider value={push}>
      {children}
      <div
        className="toast-region"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {items.map((item) => item.actor ? (
          <div className="toast toast-rich" role="status" key={item.id}>
            <Avatar person={item.actor} size="small" />
            <div className="toast-body">
              <div>
                <b>{item.actor.displayName}</b> {item.message}
                {item.meta && <div className="toast-meta">{item.meta}</div>}
              </div>
              {!!item.actions?.length && (
                <div className="toast-actions">
                  {item.actions.map((action) => (
                    <Link
                      key={action.href + action.label}
                      className={action.primary ? "toast-btn toast-btn-primary" : "toast-btn"}
                      href={action.href}
                      onClick={() => dismiss(item.id)}
                    >
                      {action.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("close")}
              onClick={() => dismiss(item.id)}
            >
              <X size={16} />
            </Button>
          </div>
        ) : (
          <div className="toast" role="status" key={item.id}>
            <span>{item.message}</span>
            {item.undo && (
              <Button
                size="small"
                disabled={item.pending}
                onClick={() => void undo(item)}
              >
                {t("undo")}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("close")}
              onClick={() => dismiss(item.id)}
            >
              <X size={16} />
            </Button>
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}
