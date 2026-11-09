"use client";

/**
 * ชิ้นส่วนมาตรฐานของ Friday Ops (O10) ตามท้ายสไตล์ของทุกหน้าใน Canvas และ M1 (สถานะหน้า)
 * หน้าเรื่องอื่น (O11–O15) ใช้ชุดนี้ · สไตล์อยู่ที่ styles/ops.css
 */
import * as RadixDialog from "@radix-ui/react-dialog";
import { clsx } from "clsx";
import { Check, Copy, LockKeyhole, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import type { OpsRole } from "@/lib/types";
import { Button } from "./ui";

// ---------------------------------------------------------------- ชิป · ปุ่มสลับ · แท็บ · สวิตช์

export function Chip({ pressed, onClick, children, className }: { pressed?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={clsx("chip", className)} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.value === value);
            if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].value);
            if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].value);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** ชิปเลือกบทบาทหลายอย่าง (A1, A2) */
export function RolePicker({ value, onChange, disabled }: { value: OpsRole[]; onChange: (v: OpsRole[]) => void; disabled?: OpsRole[] }) {
  const t = useTranslations("common");
  const all: OpsRole[] = ["support", "finance", "engineer", "auditor", "owner"];
  return (
    <div className="stack" role="group" aria-label={t("account.roles")}>
      {all.map((r) => (
        <label key={r} className="check">
          <input
            type="checkbox"
            checked={value.includes(r)}
            disabled={disabled?.includes(r)}
            onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
          />
          <span>
            <b>{t(`roles.${r}`)}</b> <span className="muted">· {t(`roleDesc.${r}`)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function RoleChips({ roles, elevated = [] }: { roles: OpsRole[]; elevated?: OpsRole[] }) {
  const t = useTranslations("common");
  return (
    <span className="row">
      {roles.map((r) => (
        <span key={r} className={clsx("pill", r === "owner" ? "inf" : "neu")}>
          {t(`roles.${r}`)}
        </span>
      ))}
      {elevated
        .filter((r) => !roles.includes(r))
        .map((r) => (
          <span key={`e-${r}`} className="pill bad">
            {t(`roles.${r}`)} ⚡
          </span>
        ))}
    </span>
  );
}

// ---------------------------------------------------------------- Drawer · Popover · แถบเตือน

export function Drawer({ open, onOpenChange, title, description, wide, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; wide?: boolean; children?: ReactNode }) {
  const t = useTranslations("common.dialog");
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className={clsx("drawer", wide && "drawer-wide")} {...(!description ? { "aria-describedby": undefined } : {})}>
          <div className="dialog-heading">
            <RadixDialog.Title asChild>
              <h2>{title}</h2>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")}>
                <X size={20} />
              </Button>
            </RadixDialog.Close>
          </div>
          {description && <RadixDialog.Description className="muted">{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Modal กลางจอที่มี class เพิ่มได้ (dialog-wide, palette) */
export function Modal({ open, onOpenChange, title, description, className, hideTitle, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; className?: string; hideTitle?: boolean; children?: ReactNode }) {
  const t = useTranslations("common.dialog");
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className={clsx("dialog", className)} {...(!description ? { "aria-describedby": undefined } : {})}>
          {hideTitle ? (
            <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          ) : (
            <div className="dialog-heading">
              <RadixDialog.Title asChild>
                <h2>{title}</h2>
              </RadixDialog.Title>
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t("close")}>
                  <X size={20} />
                </Button>
              </RadixDialog.Close>
            </div>
          )}
          {description && <RadixDialog.Description className="muted">{description}</RadixDialog.Description>}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Popover แบบเบา: ปิดเมื่อกด Esc หรือคลิกนอกกล่อง */
export function Popover({ trigger, children, label }: { trigger: (props: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div className="popover" role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Notice({ tone = "info", icon, title, children, action }: { tone?: "info" | "warn" | "bad" | "ok"; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={clsx("notice", `notice-${tone}`)} role={tone === "bad" || tone === "warn" ? "alert" : "status"}>
      {icon}
      <div className="notice-body">
        {title && <b>{title}</b>}
        {children && <span>{children}</span>}
      </div>
      {action}
    </div>
  );
}

export function PageHead({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1 className="page-title">{title}</h1>
        {desc && <div className="muted">{desc}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useTranslations("common.state");
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? t("copied") : (label ?? t("copy"))}
    </button>
  );
}

// ---------------------------------------------------------------- สถานะหน้า (M1 · S4–S7)

/** S4 · โครงตามรูปร่างจริงของตาราง ไม่ใช้วงกลมหมุนกลางจอ */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  const t = useTranslations("common.state");
  return (
    <div className="tbl-wrap" aria-busy="true" aria-label={t("loading")} role="status">
      <table className="tbl">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <span className="skeleton" style={{ width: `${50 + ((r + c) % 4) * 12}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** S5 · บอกว่าทำไมว่าง และพาไปที่ที่ควรไปต่อ · ว่างเพราะตัวกรองแสดงปุ่มล้างตัวกรอง */
export function Empty({ title, description, ok, action, onClearFilters }: { title: string; description?: string; ok?: boolean; action?: ReactNode; onClearFilters?: () => void }) {
  const t = useTranslations("common.state");
  return (
    <section className={clsx("state", ok && "state-ok")}>
      <span className="state-icon" aria-hidden="true">
        {ok ? <Check size={20} /> : "–"}
      </span>
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {onClearFilters && <Button onClick={onClearFilters}>{t("clearFilters")}</Button>}
      {action}
    </section>
  );
}

/** S6 · แสดง requestId ทุกครั้ง · ล้มเฉพาะส่วน (ใส่ในการ์ด/ตารางที่ล้ม) */
export function ErrorBlock({ error, retry }: { error: unknown; retry?: () => void }) {
  const t = useTranslations("common.state");
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.status === 403 && apiError.code === "forbidden") return <NoAccess need={(apiError.details.need as OpsRole[] | undefined) ?? []} />;
  return (
    <section className="state state-bad" role="alert">
      <span className="state-icon" aria-hidden="true">
        <TriangleAlert size={20} />
      </span>
      <h2>{t("errorTitle")}</h2>
      <p className="muted">{error instanceof Error ? error.message : ""}</p>
      {apiError?.requestId && (
        <span className="row">
          <code className="request-id">
            {t("requestId")} {apiError.requestId}
          </code>
          <CopyButton text={apiError.requestId} />
        </span>
      )}
      {retry && (
        <Button onClick={retry}>
          <RefreshCw size={16} />
          {t("retry")}
        </Button>
      )}
    </section>
  );
}

/** S7 · ไม่มีสิทธิ์ (เปิดจากลิงก์ตรง) · Owner เปิดสิทธิ์ฉุกเฉินได้จากหน้านี้ */
export function NoAccess({ need, mine = [], onBreakGlass }: { need: OpsRole[]; mine?: OpsRole[]; onBreakGlass?: () => void }) {
  const t = useTranslations("common");
  const list = (rs: OpsRole[]) => rs.map((r) => t(`roles.${r}`)).join(" · ");
  return (
    <section className="state">
      <span className="state-icon" aria-hidden="true">
        <LockKeyhole size={20} />
      </span>
      <h2>{t("state.forbiddenTitle", { roles: mine.length ? list(mine) : "–" })}</h2>
      {need.length > 0 && <p className="muted">{t("state.forbiddenFor", { roles: list(need) })}</p>}
      <p className="muted small">{t("state.askOwner")}</p>
      {onBreakGlass && (
        <Button variant="danger" onClick={onBreakGlass}>
          {t("state.breakGlass")}
        </Button>
      )}
    </section>
  );
}
