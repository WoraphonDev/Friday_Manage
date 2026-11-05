"use client";

import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CalendarDays, Check, ChevronDown, X } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDate, type YearFormat } from "@/lib/format";
import type { Person } from "@/lib/types";
import { Avatar, Button } from "./primitives";

export const YearFormatContext = createContext<YearFormat>("BE");

export function DatePicker({
  value,
  onValueChange,
  label,
  yearFormat,
  min,
  max,
}: {
  value?: string;
  onValueChange: (value: string) => void;
  label: string;
  yearFormat?: YearFormat;
  min?: string;
  max?: string;
}) {
  const t = useTranslations("common.app");
  const preference = useContext(YearFormatContext);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label id={`${id}-label`}>{label}</label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            className="picker-trigger"
            aria-labelledby={`${id}-label ${id}-value`}
          >
            <CalendarDays size={16} />
            <span id={`${id}-value`}>
              {value
                ? formatDate(value, yearFormat ?? preference, true)
                : t("date")}
            </span>
            <ChevronDown size={14} />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="popover date-popover"
            sideOffset={6}
            aria-labelledby={`${id}-label`}
          >
            <label htmlFor={id} className="sr-only">
              {label}
            </label>
            <input
              autoFocus
              className="input"
              id={id}
              type="date"
              min={min}
              max={max}
              value={value ?? ""}
              onChange={(event) => {
                onValueChange(event.target.value);
                setOpen(false);
              }}
            />
            {value && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  onValueChange("");
                  setOpen(false);
                }}
              >
                <X size={14} />
                {t("clear")}
              </Button>
            )}
            <Popover.Close className="sr-only">{t("close")}</Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function Combobox({
  options,
  value,
  onValueChange,
  label,
  multiple = false,
}: {
  options: Person[];
  value: string[];
  onValueChange: (ids: string[]) => void;
  label: string;
  multiple?: boolean;
}) {
  const t = useTranslations("common.app");
  const [open, setOpen] = useState(false);
  const id = useId();
  const selected = options.filter((person) => value.includes(person.id));
  function choose(person: Person) {
    onValueChange(
      multiple
        ? value.includes(person.id)
          ? value.filter((key) => key !== person.id)
          : [...value, person.id]
        : [person.id],
    );
    if (!multiple) setOpen(false);
  }
  return (
    <div className="field">
      <label id={id}>{label}</label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            className="picker-trigger"
            aria-labelledby={id}
            aria-haspopup="listbox"
          >
            {selected.length === 1 ? (
              <>
                <Avatar person={selected[0]} size="small" />
                <span>{selected[0].displayName}</span>
              </>
            ) : selected.length ? (
              t("selected", { count: selected.length })
            ) : (
              t("select")
            )}
            <ChevronDown size={14} />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="popover combobox-popover" sideOffset={6}>
            <Command label={label}>
              <Command.Input
                aria-label={t("search")}
                placeholder={t("search")}
              />
              <Command.List aria-label={label}>
                <Command.Empty>{t("noResults")}</Command.Empty>
                {options.map((person) => (
                  <Command.Item
                    key={person.id}
                    value={`${person.id} ${person.displayName}`}
                    onSelect={() => choose(person)}
                  >
                    <Avatar person={person} size="small" />
                    <span>{person.displayName}</span>
                    {value.includes(person.id) && (
                      <Check size={16} aria-hidden="true" />
                    )}
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
            <Popover.Close className="sr-only">{t("close")}</Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
