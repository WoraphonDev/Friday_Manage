"use client";

import { useTranslations } from "next-intl";

/** แถบ "มี n รายการใหม่ · แสดง" แทนการแทรกแถวเอง (ช่วง 2) */
export function NewItemsBar({ count, onShow }: { count: number; onShow: () => void }) {
  const t = useTranslations("common.fresh");
  if (!count) return null;
  return (
    <button type="button" className="new-items" onClick={onShow}>
      {t("show", { n: count })}
    </button>
  );
}
