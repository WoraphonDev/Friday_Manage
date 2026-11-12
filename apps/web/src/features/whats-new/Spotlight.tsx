"use client";

import { useRef } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CircleCheck, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { bodyParts, ctaHref, useLocalized, type WhatsNewItem } from "./api";
import styles from "./whats-new.module.css";

const KIND_TONE = { new: styles.kindNew, improved: styles.kindImproved, fixed: styles.kindFixed } as const;

/**
 * U2 · Spotlight ฟีเจอร์ใหญ่ (Modal ครั้งเดียว) · ปิดด้วย Esc / X / ไว้ทีหลัง / ปุ่มหลัก = เห็นแล้ว ไม่แสดงอีก
 * ปุ่มหลักพาไปหน้าที่ทีม Friday ตั้งไว้ใน U4 (นับคลิกด้วย)
 */
export function Spotlight({ ws, item, onClose }: { ws: string; item: WhatsNewItem; onClose: () => void }) {
  const t = useTranslations("whats-new");
  const router = useRouter();
  const local = useLocalized()(item);
  const done = useRef(false);
  const { steps, text } = bodyParts(local.body);
  const finish = (go?: string) => {
    if (!done.current) {
      done.current = true;
      // ปิดแล้วไม่แสดงอีกแม้บันทึกไม่สำเร็จในครั้งนี้ (ไม่บังงานซ้ำ) · ครั้งหน้า API จะส่งมาอีกถ้ายังไม่ได้บันทึก
      void api.post(`/me/spotlight/${item.id}/dismiss`).catch(() => undefined);
      if (go) void api.post(`/me/whats-new/${item.id}/click`).catch(() => undefined);
    }
    onClose();
    if (go) router.push(go);
  };
  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && finish()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className={styles.spot} aria-describedby={undefined}>
          <div className={styles.spotMedia}>
            {item.media ? (
              item.media.kind === "video" ? (
                <video src={item.media.url} autoPlay muted loop playsInline aria-label={item.media.alt} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- รูปจากที่เก็บไฟล์สาธารณะที่ API ให้ (W24)
                <img src={item.media.url} alt={item.media.alt} />
              )
            ) : (
              <Sparkles size={40} aria-hidden="true" />
            )}
            <RadixDialog.Close asChild>
              <button type="button" className={styles.spotClose} aria-label={t("spotlight.close")}>
                <X size={18} />
              </button>
            </RadixDialog.Close>
          </div>
          <div className={styles.spotBody}>
            <span className={cn(styles.kind, KIND_TONE[item.kind])}>{t(`kind.${item.kind}`)}</span>
            <RadixDialog.Title className={styles.spotTitle}>{local.title}</RadixDialog.Title>
            {steps.length ? (
              <ul className={styles.steps}>
                {steps.map((s) => (
                  <li key={s}>
                    <CircleCheck size={16} aria-hidden="true" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.summary}>{text.length ? text.join(" ") : local.summary}</p>
            )}
          </div>
          <div className={styles.spotFoot}>
            <span className={styles.spotNote}>{t("spotlight.note")}</span>
            <Button onClick={() => finish()}>{t("spotlight.later")}</Button>
            {local.cta ? (
              <Button variant="primary" onClick={() => finish(ctaHref(ws, local.cta!.path))}>
                {local.cta.label}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => finish()}>
                {t("spotlight.ok")}
              </Button>
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
