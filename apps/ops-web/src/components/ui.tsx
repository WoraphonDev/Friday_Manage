"use client";

/**
 * UI kit ส่วนที่หลังบ้านใช้ คัดลอกจาก apps/web/src/components/ui (W00) และตัดให้เหลือเท่าที่จำเป็น
 * เหตุผล: apps/web ไม่ได้เป็นแพ็กเกจที่ import ได้ (มี alias `@/` และ next-intl namespace `common` ของตัวเอง)
 * และ import ข้ามแอปแบบ relative ทำให้ Next build ต้องคอมไพล์ไฟล์นอกโปรเจกต์ · คลาส CSS ชื่อเดียวกับของ W00
 */
import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { FolderOpen, LockKeyhole, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ApiError } from "@/lib/api";

type Variant = "primary" | "secondary" | "ghost" | "danger";
export const buttonClass = (variant: Variant = "secondary", size?: "small" | "icon") =>
  clsx("button", variant !== "secondary" && `button-${variant}`, size && `button-${size}`);

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "small" | "icon" }>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={clsx(buttonClass(variant, size), className)} {...props} />;
});

type FieldProps = { label?: string; error?: string; hint?: string };
function Described({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (!error && !hint) return null;
  return (
    <span id={id} className={error ? "field-error" : "muted"} role={error ? "alert" : undefined}>
      {error ?? hint}
    </span>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(function Input({ label, error, hint, className, id, ...props }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <input ref={ref} id={inputId} className={clsx("input", className)} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${inputId}-d` : undefined} {...props} />
      <Described id={`${inputId}-d`} error={error} hint={hint} />
    </div>
  );
});
export function Textarea({ label, error, hint, className, id, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <textarea id={inputId} className={clsx("input", className)} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${inputId}-d` : undefined} {...props} />
      <Described id={`${inputId}-d`} error={error} hint={hint} />
    </div>
  );
}
export function Select({ label, error, hint, id, className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <div className="field">
      {label && <label htmlFor={selectId}>{label}</label>}
      <select id={selectId} className={clsx("input select", className)} aria-invalid={error ? true : undefined} {...props}>
        {children}
      </select>
      <Described id={`${selectId}-d`} error={error} hint={hint} />
    </div>
  );
}

/** สีตาม Canvas: ok / warn / bad / neu / inf */
export type Tone = "ok" | "warn" | "bad" | "neu" | "inf";
export function Pill({ children, tone = "neu", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={clsx("pill", tone, className)}>{children}</span>;
}

// Dialog ------------------------------------------------------------------------
export function Dialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children?: ReactNode }) {
  const t = useTranslations("ops.ui");
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className="dialog" {...(!description ? { "aria-describedby": undefined } : {})}>
          <div className="dialog-heading">
            <RadixDialog.Title>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")}>
                <X size={20} />
              </Button>
            </RadixDialog.Close>
          </div>
          {description && <RadixDialog.Description className="muted">{description}</RadixDialog.Description>}
          <div className="dialog-body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// Toast -------------------------------------------------------------------------
const ToastContext = createContext<(message: string) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("ops.ui");
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);
  const push = useCallback(
    (message: string) => {
      const id = ++next.current;
      setItems((prev) => [...prev, { id, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), 5000));
    },
    [dismiss],
  );
  useEffect(() => {
    const current = timers.current;
    return () => current.forEach((timer) => clearTimeout(timer));
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((item) => (
          <div className="toast" role="status" key={item.id}>
            <span>{item.message}</span>
            <Button size="icon" variant="ghost" aria-label={t("close")} onClick={() => dismiss(item.id)}>
              <X size={16} />
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// สถานะหน้าจอ (M1) ----------------------------------------------------------------
function State({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return (
    <section className="state">
      <span className="state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </section>
  );
}
export function LoadingState() {
  const t = useTranslations("ops.ui");
  return (
    <div className="loading-state" aria-label={t("loading")} aria-busy="true" role="status">
      <span className="skeleton skeleton-heading" />
      <span className="skeleton" />
      <span className="skeleton" />
      <span className="skeleton" />
    </div>
  );
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <State icon={<FolderOpen />} title={title} description={description}>
      {action}
    </State>
  );
}
export function Forbidden({ need }: { need?: unknown }) {
  const t = useTranslations("ops");
  const roles = Array.isArray(need) && need.length ? need.map((r) => t(`roles.${String(r) as "admin"}`)).join(", ") : t("roles.admin");
  return <State icon={<LockKeyhole />} title={t("ui.forbiddenTitle")} description={t("ui.forbiddenDescription", { roles })} />;
}
/** Error พร้อม requestId · 403 ของบทบาทแสดงเป็นหน้าไม่มีสิทธิ์ */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslations("ops.ui");
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.status === 403 && apiError.code === "forbidden") return <Forbidden need={apiError.details.need} />;
  return (
    <div role="alert">
      <State icon={<TriangleAlert />} title={t("errorTitle")} description={error instanceof Error ? error.message : t("unknownError")}>
        {apiError?.requestId && <code className="request-id">{t("requestId", { id: apiError.requestId })}</code>}
        {retry && (
          <Button onClick={retry}>
            <RefreshCw size={16} />
            {t("retry")}
          </Button>
        )}
      </State>
    </div>
  );
}
/** ข้อความ error ในฟอร์ม/Dialog (ไม่แทนทั้งหน้า) */
export function InlineError({ error }: { error: unknown }) {
  const t = useTranslations("ops.ui");
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  return (
    <div className="inline-error" role="alert">
      <span>{error instanceof Error ? error.message : t("unknownError")}</span>
      {apiError?.requestId && <code className="request-id">{t("requestId", { id: apiError.requestId })}</code>}
    </div>
  );
}
