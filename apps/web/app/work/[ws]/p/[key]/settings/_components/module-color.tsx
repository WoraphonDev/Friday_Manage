"use client";

import { useState, type CSSProperties } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";
import { DEFAULT_ITEM_COLOR, MODULE_COLORS, isNearLateRed } from "@/lib/colors";
import styles from "./settings.module.css";

/**
 * เลือกสี Module (ตามแบบที่ผู้ใช้เลือก 2026-11-14): ชุดสี 12 สี · ใส่รหัสสีเอง · เตือนถ้าใกล้สีแดงของงานเลยกำหนด
 * พร้อมแถบตัวอย่าง "งานปกติ / เลยกำหนด" ให้เห็นว่าแยกกันออกไหม · บันทึกทันทีที่เลือก
 */
export function ModuleColorPicker({ name, value, onChange }: { name: string; value: string | null; onChange: (color: string) => void }) {
  const t = useTranslations("project-settings-new.settings.modules");
  const saved = (value ?? DEFAULT_ITEM_COLOR).toLowerCase();
  // เลือก/ลากวงล้อสีได้อิสระ แล้วบันทึกครั้งเดียวตอนปิดตัวเลือก (ลากวงล้อสียิงค่าถี่มาก ไม่ควรบันทึกทุกครั้ง)
  const [draft, setDraft] = useState(saved);
  const [text, setText] = useState(saved.toUpperCase());
  const pick = (c: string) => {
    setDraft(c.toLowerCase());
    setText(c.toUpperCase());
  };
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) pick(saved);
        else if (draft !== saved) onChange(draft);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={styles.modColorBtn} aria-label={t("colorOf", { name })}>
          <i style={{ background: draft }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`popover ${styles.modColorPop}`} sideOffset={6} align="start" aria-label={t("colorOf", { name })}>
          <b className={styles.modColorHead}>{t("colorPreset")}</b>
          <div className={styles.modSwatches}>
            {MODULE_COLORS.map((c) => (
              <button key={c} type="button" className={styles.swatchBtn} style={{ background: c }} aria-label={c} aria-pressed={draft === c} onClick={() => pick(c)}>
                {draft === c && <Check size={12} strokeWidth={3} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <b className={styles.modColorHead}>{t("colorCustom")}</b>
          <div className={styles.modCustom}>
            <input type="color" value={draft} aria-label={t("colorWheel")} onChange={(e) => pick(e.target.value)} />
            <input
              className={styles.in}
              value={text}
              maxLength={7}
              aria-label={t("colorHex")}
              onChange={(e) => {
                setText(e.target.value);
                const v = e.target.value.trim().replace(/^#?/, "#");
                if (/^#[0-9a-f]{6}$/i.test(v)) setDraft(v.toLowerCase());
              }}
              onBlur={() => setText(draft.toUpperCase())}
            />
          </div>
          {isNearLateRed(draft) && (
            <div className={styles.modWarn} role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              {t("colorNearLate")}
            </div>
          )}
          <div className={styles.modPreview} style={{ "--mc": draft } as CSSProperties}>
            <span>{t("previewTitle")}</span>
            <div><small>{t("previewNormal")}</small><i /></div>
            <div><small>{t("previewLate")}</small><i className={styles.modPreviewLate} /></div>
          </div>
          <Popover.Close asChild>
            <Button size="small" variant="primary" className={styles.modColorDone}>{t("colorDone")}</Button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
