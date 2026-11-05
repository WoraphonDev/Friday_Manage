"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { useRef, useState, type ReactNode } from "react";
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
}: OverlayProps) {
  const t = useTranslations("common.app");
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content
          className="dialog"
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

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  depth = 1,
  parentLabel,
  onBack,
}: OverlayProps & {
  depth?: 1 | 2;
  parentLabel?: string;
  onBack?: () => void;
}) {
  const t = useTranslations("common.app");
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content
          className={cn("drawer", depth === 2 && "drawer-nested")}
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
          <div className="drawer-body">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
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
