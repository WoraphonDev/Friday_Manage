"use client";

// W21 · ตัวสลับภาษา TH / EN และรูปแบบปี (Canvas R3)
// ล็อกอินแล้ว: บันทึกที่บัญชีผ่าน PATCH /me (แจ้งเตือนส่งตามภาษาของผู้รับ) + cookie
// หน้าสาธารณะ: cookie `NEXT_LOCALE` อย่างเดียว · แล้ว router.refresh() ให้ server โหลดข้อความภาษาใหม่
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { YearFormat } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Me } from "@/lib/types";
import { readLocaleCookie, writeLocaleCookie } from "./cookie";
import { LABELS } from "./labels";
import {
  DEFAULT_LOCALE,
  LANGUAGE_NAMES,
  LOCALES,
  defaultYearFormat,
  effectiveYearFormat,
  isLocale,
  type AppLocale,
} from "./locale";
import styles from "./locale-switch.module.css";

const YEARS: YearFormat[] = ["BE", "CE"];

export interface LocaleSwitchProps {
  /** true = ผู้ใช้ล็อกอินอยู่ บันทึกค่าลงบัญชีด้วย */
  signedIn?: boolean;
  /** แสดงตัวเลือก พ.ศ. / ค.ศ. ต่อท้าย (ใช้ได้เมื่อ signedIn) */
  showYearFormat?: boolean;
  /** เรียกหลังเปลี่ยนสำเร็จ เช่น ปิดเมนู */
  onChange?: (value: { locale: AppLocale; yearFormat: YearFormat }) => void;
  className?: string;
}

export function LocaleSwitch({
  signedIn = false,
  showYearFormat = false,
  onChange,
  className,
}: LocaleSwitchProps) {
  const intlLocale = useLocale();
  const locale: AppLocale = isLocale(intlLocale) ? intlLocale : DEFAULT_LOCALE;
  const labels = LABELS[locale];
  const router = useRouter();
  const cache = useQueryClient();
  const toast = useToast();
  // ใช้ query เดียวกับ shell จึงไม่ยิงซ้ำเมื่อ shell โหลดไว้แล้ว
  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<Me>("/me"),
    enabled: signedIn,
  }).data;
  const [pending, setPending] = useState(false);
  const year = effectiveYearFormat(locale, signedIn ? me?.yearFormat : null);

  const save = async (next: AppLocale, nextYear: YearFormat) => {
    if (pending) return;
    setPending(true);
    try {
      if (signedIn) {
        const body: Partial<Pick<Me, "locale" | "yearFormat">> = {};
        if (next !== locale) body.locale = next;
        if (nextYear !== me?.yearFormat) body.yearFormat = nextYear;
        if (Object.keys(body).length > 0) {
          const updated = await api.request<Me>("/me", {
            method: "PATCH",
            body,
          });
          cache.setQueryData<Me>(queryKeys.me, (old) =>
            old ? { ...old, ...updated } : updated,
          );
        }
      }
      if (next !== locale) {
        writeLocaleCookie(next);
        // ให้โปรแกรมอ่านหน้าจอเปลี่ยนเสียงทันที ก่อน layout ของ server ส่ง lang ใหม่มา
        document.documentElement.lang = next;
        router.refresh();
      }
      onChange?.({ locale: next, yearFormat: nextYear });
    } catch (error) {
      toast({
        message:
          error instanceof ApiError && error.message
            ? error.message
            : labels.failed,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={[styles.root, className].filter(Boolean).join(" ")}>
      <div
        className={styles.seg}
        role="group"
        aria-label={labels.language}
        aria-busy={pending || undefined}
      >
        {LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={option === locale}
            disabled={pending}
            // เปลี่ยนภาษา = ตั้งปีตามค่าเริ่มต้นของภาษานั้น (Canvas: ไทย → พ.ศ. · English → ค.ศ.)
            onClick={() =>
              option !== locale && void save(option, defaultYearFormat(option))
            }
          >
            {LANGUAGE_NAMES[option]}
          </button>
        ))}
      </div>
      {showYearFormat && signedIn && (
        <div
          className={styles.seg}
          role="group"
          aria-label={labels.yearFormat}
          aria-busy={pending || undefined}
        >
          {YEARS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === year}
              disabled={pending}
              onClick={() => option !== year && void save(locale, option)}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ทำให้ cookie ตรงกับภาษาที่บันทึกในบัญชี (เช่น เปลี่ยนภาษาจากอีกเครื่อง)
 * วางใน shell หลังโหลด GET /me · ถ้าไม่ตรงจะเขียน cookie แล้ว refresh ครั้งเดียว
 */
export function LocaleSync({ me }: { me: Pick<Me, "locale"> | undefined }) {
  const intlLocale = useLocale();
  const router = useRouter();
  useEffect(() => {
    const saved = me?.locale;
    if (!isLocale(saved)) return;
    if (saved === intlLocale && readLocaleCookie() === saved) return;
    writeLocaleCookie(saved);
    if (saved !== intlLocale) router.refresh();
  }, [me?.locale, intlLocale, router]);
  return null;
}
