"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useInViewOnce, useSequence } from "./motion";
import styles from "./landing.module.css";

/*
 * ภาพเล็กของการ์ดฟีเจอร์ (R1) · เล่นหนึ่งรอบเมื่อเลื่อนมาเห็น และเล่นใหม่เมื่อชี้
 * ค่าเริ่มต้นเป็นภาพขั้นสุดท้าย จึงครบตั้งแต่ server render และตอนผู้ใช้ลดการเคลื่อนไหว · ข้อมูลเป็นตัวอย่างสมมติ
 */

export type DemoKind = "size" | "load" | "import" | "sub" | "bug" | "line";
/** ลำดับเดียวกับ saas-pages.landing.features */
export const DEMO_ORDER: DemoKind[] = ["size", "load", "import", "sub", "bug", "line"];

const DELAYS: Record<DemoKind, readonly number[]> = {
  size: [600, 1250, 1900, 2550, 3200],
  load: [60, 800, 1150],
  import: [250, 460, 670, 880, 1090, 1300, 1510, 1720, 1930],
  sub: [500, 1150, 1800],
  bug: [800, 1700],
  line: [800, 1700, 2000],
};
const TONE: Record<DemoKind, string> = { size: "review", load: "progress", import: "done", sub: "overdue", bug: "review", line: "done" };

const bold = { b: (chunks: ReactNode) => <b>{chunks}</b> };
const Check = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function FeatureCard({ kind, name, description }: { kind: DemoKind; name: string; description: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { step, start } = useSequence(DELAYS[kind]);
  useInViewOnce(ref, start);
  const Demo = DEMOS[kind];
  return (
    <div ref={ref} className={styles.feat} data-reveal="" onPointerEnter={start}>
      <div className={styles.demo} aria-hidden="true">
        <Demo step={step} />
      </div>
      <div className={styles.featText}>
        <b>
          <i data-tone={TONE[kind]} />
          {name}
        </b>
        <span>{description}</span>
      </div>
    </div>
  );
}

// 1 · Size → Man-Day นับเฉพาะวันทำการ (XS 1 · S 3 · M 5 · L 8 · XL 12 ตาม docs/decisions.md)
const SIZES = [
  ["XS", 1],
  ["S", 3],
  ["M", 5],
  ["L", 8],
  ["XL", 12],
] as const;
const SIZE_STEPS = [0, 1, 2, 3, 4, 2];
function SizeDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.size");
  const i = SIZE_STEPS[step] ?? 2;
  const md = SIZES[i]![1];
  const ends = t.raw("ends") as string[];
  return (
    <>
      <div className={styles.sizes} style={{ "--i": i } as CSSProperties}>
        <i className={styles.sizeInd} />
        {SIZES.map(([s], k) => (
          <span key={s} className={cn(k === i && styles.on)}>
            {s}
          </span>
        ))}
      </div>
      <div className={styles.mdRow}>
        <b key={md}>{md}</b>
        <span>Man-Day</span>
      </div>
      <div className={styles.daysStrip}>
        {Array.from({ length: 10 }, (_, d) => (
          <i key={d} className={cn(d < md && styles.f, d === 5 && styles.afterWeekend)} />
        ))}
        <span>{md > 10 ? `+${md - 10}` : ""}</span>
      </div>
      <div className={styles.dCap}>
        {t("start")} <b>{ends[i]}</b> · {t("skip")}
      </div>
    </>
  );
}

// 2 · Workload ข้ามโปรเจกต์: เส้นประคือ 5 MD เต็มสัปดาห์
const LOADS = [
  { who: "p", v: 3.5 },
  { who: "k", v: 6.5 },
  { who: "s", v: 2.5 },
] as const;
function LoadDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.load");
  const people = useTranslations("saas-pages.landing.preview.people");
  return (
    <>
      <div className={styles.dHead}>
        <span>{t("week")}</span>
        <span>{t("full")}</span>
      </div>
      {LOADS.map(({ who, v }) => {
        const over = v > 5 && step >= 2;
        return (
          <div key={who} className={cn(styles.lrow, over && styles.over)}>
            <span className={styles.av} data-who={who}>
              {people(who)}
            </span>
            <div className={styles.ltrk}>
              <i style={{ width: step >= 1 ? `${(v / 7.5) * 100}%` : "0%" }} />
            </div>
            <span className={styles.lv}>
              <b>{v}</b> MD{over && <em>{t("over")}</em>}
            </span>
          </div>
        );
      })}
      <div className={cn(styles.dCap, step < 3 && styles.hide)}>{t.rich("note", bold)}</div>
    </>
  );
}

// 3 · Import Excel: ตรวจทีละแถว แถวที่วันที่ไม่มีจริงถูกจับก่อนนำเข้า
const ROWS = [
  ["FM-201", "Payment callback", "16/11/2026", true],
  ["FM-202", "Booking flow UI", "17/11/2026", true],
  ["FM-203", "Export report", "31/11/2026", false],
  ["FM-204", "LINE reminder", "18/11/2026", true],
] as const;
function ImportDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.import");
  return (
    <>
      <div className={styles.sheet}>
        <div className={cn(styles.sr, styles.hd)}>
          <span>Key</span>
          <span>Title</span>
          <span>Plan Start</span>
          <span />
        </div>
        {ROWS.map(([key, title, date, ok], i) => {
          const checked = step >= i * 2 + 2;
          return (
            <div key={key} className={cn(styles.sr, step === i * 2 + 1 && styles.scan, checked && !ok && styles.bad)}>
              <span>{key}</span>
              <span>{title}</span>
              <span className={styles.dt}>{date}</span>
              {checked ? <span className={cn(styles.st, ok ? styles.ok : styles.no)}>{ok ? "✓" : "!"}</span> : <span />}
            </div>
          );
        })}
      </div>
      <div className={cn(styles.dCap, step < ROWS.length * 2 + 1 && styles.hide)}>{t.rich("note", bold)}</div>
    </>
  );
}

// 4 · Task › Sub-task: Sub-task เสร็จทีละข้อพร้อม Commit / PR / ผลทดสอบ
function SubDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.sub");
  const people = useTranslations("saas-pages.landing.preview.people");
  const items = t.raw("items") as string[];
  const chips = [
    { cls: styles.commit, text: "✓ 4e1c09a" },
    { cls: styles.pr, text: "PR #212" },
    { cls: styles.commit, text: t("passed", { n: "24/24" }) },
  ];
  const who = ["p", "k", "s"] as const;
  const pct = Math.round((step / items.length) * 100);
  return (
    <>
      <div className={styles.par}>
        <b>FM-142</b>Login + 2FA<span>{pct}%</span>
      </div>
      <div className={styles.pbar}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <ul className={styles.subs}>
        {items.map((label, i) => (
          <li key={label} className={cn(i < step && styles.done)}>
            <span className={styles.ck}>
              <Check />
            </span>
            <span>{label}</span>
            <span className={styles.av} data-who={who[i]}>
              {people(who[i]!)}
            </span>
            <span className={cn(styles.chip, chips[i]!.cls)}>{chips[i]!.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// 5 · Bug workflow: Open → Fixed → Verified ผูกกับ Commit และผลทดสอบ
function BugDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.bug");
  const evidence = ["Commit 9a0c6e8", t("passed", { n: "24/24" })];
  return (
    <>
      <div className={styles.bugT}>
        <b>BUG-57</b>
        {t("title")}
      </div>
      <div className={styles.steps}>
        <div className={styles.line}>
          <i style={{ width: `${step * 50}%` }} />
        </div>
        {["Open", "Fixed", "Verified"].map((s, i) => (
          <span key={s} className={cn(styles.nd, i === 0 && styles.open, i <= step && styles.on)}>
            {s}
          </span>
        ))}
      </div>
      <div className={styles.ev}>
        {evidence.map((e, i) => (
          <span key={e} className={cn(styles.chip, styles.commit, i >= step && styles.hide)}>
            {e}
          </span>
        ))}
      </div>
    </>
  );
}

// 6 · LINE: อนุมัติเลื่อน Due ในแชต
function LineDemo({ step }: { step: number }) {
  const t = useTranslations("saas-pages.landing.demos.line");
  return (
    <div className={styles.chat}>
      {step === 0 && (
        <div className={styles.typing}>
          <i />
          <i />
          <i />
        </div>
      )}
      {step >= 1 && (
        <div className={cn(styles.bub, styles.incoming)}>
          <b>Friday</b>
          {t("ask")}
          <div className={styles.acts}>
            <span className={cn(styles.yes, step === 2 && styles.press)}>{t("approve")}</span>
            <span>{t("reject")}</span>
          </div>
        </div>
      )}
      {step >= 3 && <div className={cn(styles.bub, styles.outgoing)}>{t("done")}</div>}
    </div>
  );
}

const DEMOS: Record<DemoKind, (props: { step: number }) => ReactNode> = {
  size: SizeDemo,
  load: LoadDemo,
  import: ImportDemo,
  sub: SubDemo,
  bug: BugDemo,
  line: LineDemo,
};
