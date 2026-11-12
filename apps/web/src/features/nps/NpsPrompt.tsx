"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { CircleCheck, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/use-mobile";
import styles from "./nps.module.css";

/** คำตอบของ GET me/nps-prompt เมื่อถาม (A42) */
export interface NpsAsk {
  ask: true;
  question: string;
  questionEn: string | null;
  followUps: Record<string, string>;
  followUpsEn: Record<string, string> | null;
  topics: string[];
  excludeShortMobile: boolean;
}
type Group = "detractor" | "passive" | "promoter";
const groupOf = (n: number): Group => (n <= 6 ? "detractor" : n <= 8 ? "passive" : "promoter");
const SCORES = Array.from({ length: 11 }, (_, i) => i);
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "";

/**
 * U3 · แบบสำรวจ NPS 3 ขั้น (คะแนน → คำถามต่อตามกลุ่มคะแนน → ขอบคุณ)
 * จอใหญ่: การ์ดมุมขวาล่าง ไม่มีพื้นหลังมืด ไม่บังงาน · มือถือ: Bottom sheet
 * ข้ามได้ทุกขั้น: ปิดก่อนให้คะแนน = ปิดโดยไม่ตอบ · ปิดหลังให้คะแนน = ส่งคะแนนอย่างเดียว
 */
export function NpsPrompt({ ws, prompt, onClose }: { ws: string; prompt: NpsAsk; onClose: () => void }) {
  const t = useTranslations("whats-new.nps");
  const en = useLocale() === "en";
  const mobile = useIsMobile();
  const [score, setScore] = useState<number | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [step, setStep] = useState<"score" | "more" | "thanks">("score");
  const sent = useRef(false);
  const question = (en && prompt.questionEn) || prompt.question;
  const followUp = (g: Group) => (en && prompt.followUpsEn?.[g]) || prompt.followUps[g] || "";
  const topicLabel = (x: string) => (t.has(`topic.${x}` as never) ? t(`topic.${x}` as never) : x);

  const answer = useMutation({
    mutationFn: (body: { score: number; comment?: string; topics?: string[] }) => api.post("/me/nps", { workspace: ws, ...body }),
  });
  const dismiss = () => {
    if (!sent.current) {
      sent.current = true;
      void api.post("/me/nps/dismiss", { workspace: ws }).catch(() => undefined);
    }
    onClose();
  };
  /** ปิดหลังเลือกคะแนน: ส่งคะแนนอย่างเดียว (ไม่รอผล ไม่บังงาน) */
  const closeWithScore = () => {
    if (!sent.current && score !== null) {
      sent.current = true;
      answer.mutate({ score });
    }
    onClose();
  };
  const submit = () => {
    if (score === null || sent.current) return;
    answer.mutate(
      { score, ...(comment.trim() ? { comment: comment.trim() } : {}), ...(topics.length ? { topics } : {}) },
      {
        onSuccess: () => {
          sent.current = true;
          setStep("thanks");
        },
      },
    );
  };

  const close = step === "score" ? dismiss : step === "more" ? closeWithScore : onClose;
  const scores = (
    <div className={mobile ? styles.scoresGrid : styles.scores} role="group" aria-label={question}>
      {SCORES.map((n) => (
        <button
          key={n}
          type="button"
          className={styles.score}
          aria-pressed={score === n}
          aria-label={t("scoreLabel", { score: n })}
          onClick={() => {
            setScore(n);
            setStep("more");
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
  const body =
    step === "score" ? (
      <>
        <div className={styles.headRow}>
          <b className={styles.question}>{question}</b>
          {!mobile && (
            <button type="button" className={styles.close} aria-label={t("close")} onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
        {scores}
        <div className={styles.ends}>
          <span>{mobile ? t("lowMobile") : t("low")}</span>
          <span>{mobile ? t("highMobile") : t("high")}</span>
        </div>
        {mobile && (
          <div className={styles.notNow}>
            <Button variant="ghost" onClick={dismiss}>
              {t("notNow")}
            </Button>
          </div>
        )}
      </>
    ) : step === "more" ? (
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={styles.headRow}>
          <b className={styles.question}>{t("thanksPrefix", { question: followUp(groupOf(score!)) })}</b>
          <button type="button" className={styles.close} aria-label={t("close")} onClick={close}>
            <X size={16} />
          </button>
        </div>
        {prompt.topics.length > 0 && (
          <div className={styles.chips} role="group" aria-label={t("topics")}>
            {prompt.topics.map((x) => (
              <button key={x} type="button" className={styles.chip} aria-pressed={topics.includes(x)} onClick={() => setTopics((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x]))}>
                {topicLabel(x)}
              </button>
            ))}
          </div>
        )}
        <textarea className={cn("input", styles.textarea)} aria-label={t("comment")} placeholder={t("comment")} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        {answer.isError && (
          <span className={styles.error} role="alert">
            {t("failed")}
          </span>
        )}
        <div className={styles.footRow}>
          <span className={styles.note}>{t("anonymous")}</span>
          <Button type="submit" variant="primary" size="small" disabled={answer.isPending}>
            {t("send")}
          </Button>
        </div>
      </form>
    ) : (
      <>
        <div className={styles.thanks}>
          <span className={styles.ok} aria-hidden="true">
            <CircleCheck size={18} />
          </span>
          <div>
            <b className={styles.question}>{t("thanks")}</b>
            <div className={styles.note}>{t("thanksBody")}</div>
          </div>
        </div>
        <div className={styles.actions}>
          {SUPPORT_EMAIL && (
            <a className={buttonVariants({ size: "small" })} href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t("contactSubject"))}`}>
              {t("contact")}
            </a>
          )}
          <Button variant="ghost" size="small" onClick={onClose}>
            {t("done")}
          </Button>
        </div>
      </>
    );
  if (mobile)
    return (
      <>
        <div className={styles.dim} aria-hidden="true" onClick={close} />
        <section className={styles.sheet} role="dialog" aria-modal="false" aria-label={t("region")}>
          <div className={styles.grab} aria-hidden="true" />
          {body}
        </section>
      </>
    );
  return (
    <section className={styles.card} role="dialog" aria-modal="false" aria-label={t("region")}>
      {body}
    </section>
  );
}
