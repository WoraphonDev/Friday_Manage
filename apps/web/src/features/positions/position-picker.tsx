"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { POSITION_GROUPS, POSITIONS, positionLabel, toPositionCode } from "@/lib/positions";
import styles from "./position-picker.module.css";

/**
 * เลือกตำแหน่งได้หลายตำแหน่ง (ผู้ใช้ขอ 2026-11-13) · แบบค้นหาได้ (ผู้ใช้เลือก storyboard 2026-11-16)
 * แสดงเป็นป้ายเฉพาะที่เลือกแล้ว · ตำแหน่งทั้งหมดอยู่ในรายการ "+ เพิ่มตำแหน่ง" แบ่งกลุ่มตามสายงาน จึงมีกี่ตำแหน่งหน้าต่างก็สูงเท่าเดิม
 * ค่าที่ไม่อยู่ในชุดมาตรฐาน (ข้อมูลเดิมที่พิมพ์เอง) แสดงเป็นป้ายเพื่อเอาออกได้
 */
export function PositionPicker({ label, value, onChange }: { label: string; value: string[]; onChange: (next: string[]) => void }) {
  const t = useTranslations("common.positions");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const codes = [...new Set(value.map(toPositionCode).filter(Boolean))];
  const toggle = (code: string) => onChange(codes.includes(code) ? codes.filter((c) => c !== code) : [...codes, code]);
  const q = query.trim().toLowerCase();
  const matches = POSITIONS.filter((p) => !q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));

  return (
    <fieldset className={styles.box}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.picked}>
        {codes.length ? (
          codes.map((code) => (
            <span key={code} className={styles.pill}>
              {positionLabel(code)}
              <button type="button" className={styles.remove} aria-label={t("remove", { name: positionLabel(code) })} onClick={() => toggle(code)}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))
        ) : (
          <span className={styles.none}>{t("none")}</span>
        )}
      </div>
      <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
        <Popover.Trigger asChild>
          <button type="button" className={styles.add}>
            <Plus size={14} aria-hidden="true" /> {t("add")}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={styles.pop} align="start" sideOffset={6} collisionPadding={12}>
            <input
              className={styles.search}
              type="search"
              value={query}
              placeholder={t("search")}
              aria-label={t("search")}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter = เลือกตำแหน่งแรกที่ตรงคำค้น
                if (e.key === "Enter" && matches[0]) {
                  e.preventDefault();
                  toggle(matches[0].code);
                }
              }}
            />
            <div className={styles.list} role="group" aria-label={t("listLabel")}>
              {POSITION_GROUPS.map((group) => {
                const items = matches.filter((p) => p.group === group);
                if (!items.length) return null;
                return (
                  <div key={group} className={styles.group}>
                    <div className={styles.groupName}>{t(`groups.${group}`)}</div>
                    {items.map((p) => {
                      const on = codes.includes(p.code);
                      return (
                        <button key={p.code} type="button" className={styles.item} aria-pressed={on} aria-label={positionLabel(p.code)} onClick={() => toggle(p.code)}>
                          <span className={styles.check} aria-hidden="true">{on && <Check size={14} />}</span>
                          <b>{p.code}</b>
                          <span className={styles.full}>{p.name}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {!matches.length && <div className={styles.empty}>{t("noMatch")}</div>}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </fieldset>
  );
}
