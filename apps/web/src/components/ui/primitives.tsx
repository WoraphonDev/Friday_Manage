"use client";

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Person } from "@/lib/types";

export const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
    size: { default: "", small: "button-small", icon: "button-icon" },
  },
  defaultVariants: { variant: "secondary", size: "default" },
});
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

type FieldProps = { label?: string; error?: string; hint?: string };
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldProps
>(function Input({ label, error, hint, className, id, ...props }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  const descriptionId = `${inputId}-description`;
  return (
    <div className="field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <input
        ref={ref}
        id={inputId}
        className={cn("input", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error || hint ? descriptionId : props["aria-describedby"]
        }
        {...props}
      />
      {(error || hint) && (
        <span
          id={descriptionId}
          className={error ? "field-error" : "muted"}
          role={error ? "alert" : undefined}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  );
});

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> &
  FieldProps & {
    /** small = 36px สำหรับแถบตัวกรอง (เท่าปุ่มใน Canvas) · default = 40px สำหรับฟอร์ม */
    size?: "default" | "small";
    /** คำนำหน้าในกล่องแบบ Canvas Kanban เช่น "แสดง Task + Sub-task" · ค่าที่เลือกเป็นตัวหนาสีหลัก */
    prefix?: string;
  };

/**
 * ใช้ <select> ของ browser (keyboard / screen reader / มือถือได้ครบ) แต่ซ่อนลูกศรเดิม
 * เพราะลูกศรของ browser ไม่เว้นระยะจากข้อความและหน้าตาต่างกันแต่ละเครื่อง
 */
export function Select({
  label,
  error,
  hint,
  id,
  className,
  children,
  size = "default",
  prefix,
  ...props
}: SelectProps) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <div className="field">
      {label && <label htmlFor={selectId}>{label}</label>}
      <div
        className={cn(
          "select",
          size === "small" && "select-small",
          prefix && "select-prefixed",
          className,
        )}
      >
        {prefix && (
          <span className="select-prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error || hint ? `${selectId}-description` : undefined
          }
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="select-chevron" size={16} aria-hidden="true" />
      </div>
      {(error || hint) && (
        <span
          id={`${selectId}-description`}
          className={error ? "field-error" : "muted"}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export type Tone =
  | "neutral"
  | "blue"
  | "amber"
  | "green"
  | "red"
  | "purple"
  | "teal";
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span className={cn("badge", `tone-${tone}`, className)}>{children}</span>
  );
}
export function StatusPill({
  status,
  label,
}: {
  status: "todo" | "in_progress" | "review" | "done" | "overdue";
  label?: string;
}) {
  const t = useTranslations("common.status");
  const tone: Record<typeof status, Tone> = {
    todo: "neutral",
    in_progress: "blue",
    review: "amber",
    done: "green",
    overdue: "red",
  };
  return (
    <Badge tone={tone[status]}>
      <span className="status-dot" />
      {label ?? t(status)}
    </Badge>
  );
}
export function PriorityTag({
  priority,
}: {
  priority: "urgent" | "high" | "medium" | "low";
}) {
  const t = useTranslations("common.priority");
  return (
    <Badge
      tone={
        priority === "urgent"
          ? "red"
          : priority === "high"
            ? "amber"
            : "neutral"
      }
    >
      {priority === "urgent" || priority === "high"
        ? "↑"
        : priority === "low"
          ? "↓"
          : "−"}{" "}
      {t(priority)}
    </Badge>
  );
}

const colors = ["#1d4ed8", "#b45309", "#0f766e", "#7c3aed", "#be185d"];
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
}
export function Avatar({
  person,
  size = "default",
}: {
  person: Person;
  size?: "small" | "default" | "large";
}) {
  const hash = Array.from(person.id).reduce(
    (value, char) => value + char.charCodeAt(0),
    0,
  );
  return (
    <span
      className={cn("avatar", `avatar-${size}`)}
      style={{ background: person.color ?? colors[hash % colors.length] }}
      aria-label={person.displayName}
      role="img"
      title={person.displayName}
    >
      {person.avatarUrl ? (
        <img src={person.avatarUrl} alt="" />
      ) : (
        (person.initials ?? initials(person.displayName))
      )}
    </span>
  );
}
export function AvatarStack({
  people,
  max = 3,
}: {
  people: Person[];
  max?: number;
}) {
  const t = useTranslations("common.app");
  return (
    <span className="avatar-stack">
      {people.slice(0, max).map((person) => (
        <Avatar key={person.id} person={person} />
      ))}
      {people.length > max && (
        <span
          className="avatar avatar-overflow"
          aria-label={t("morePeople", { count: people.length - max })}
        >
          +{people.length - max}
        </span>
      )}
    </span>
  );
}

export function Tabs({
  items,
  value,
  onValueChange,
  label,
}: {
  items: {
    value: string;
    label: string;
    content?: ReactNode;
    disabled?: boolean;
  }[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List className="tabs" aria-label={label}>
        {items.map((item) => (
          <RadixTabs.Trigger
            className="tab"
            key={item.value}
            value={item.value}
            disabled={item.disabled}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content
          className="tab-content"
          key={item.value}
          value={item.value}
        >
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
}
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
}) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tooltip({
  children,
  content,
}: {
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <RadixTooltip.Provider delayDuration={250}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="tooltip" sideOffset={6}>
            {content}
            <RadixTooltip.Arrow />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
export function Skeleton({ className }: { className?: string }) {
  const t = useTranslations("common.app");
  return (
    <span
      role="status"
      aria-label={t("loading")}
      className={cn("skeleton", className)}
    />
  );
}
