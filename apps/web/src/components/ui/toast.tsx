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
import { X } from "lucide-react";
import { Button } from "./primitives";

export interface ToastOptions {
  message: string;
  undo?: () => void | Promise<void>;
  duration?: number;
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
        {items.map((item) => (
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
