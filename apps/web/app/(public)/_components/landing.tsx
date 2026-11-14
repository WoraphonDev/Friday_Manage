"use client";

import { Fragment, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui";
import { cn } from "@/lib/utils";
import { DEMO_ORDER, FeatureCard } from "./feature-demos";
import { HeroPreview } from "./hero-preview";
import { useReveal } from "./motion";
import { PricingSection } from "./pricing";
import { SiteFooter, SiteHeader } from "./site";
import motion from "./landing.module.css";
import styles from "./public.module.css";

// ไทล์ 4 สีของ logo ลอยอยู่หลัง Hero · z = ระยะขยับตามเมาส์ (ใกล้ = ขยับมาก)
const TILES = [
  { x: "91%", y: "4%", s: 64, tone: "review", r: -14, z: 0.9, t: 10, d: 0 },
  { x: "47%", y: "8%", s: 26, tone: "progress", r: 12, z: 0.4, t: 8, d: -3 },
  { x: "96%", y: "70%", s: 44, tone: "done", r: -6, z: 1, t: 11, d: -5 },
  { x: "40%", y: "88%", s: 34, tone: "overdue", r: 20, z: 0.6, t: 7, d: -2 },
  { x: "3%", y: "10%", s: 18, tone: "done", r: 8, z: 0.3, t: 9, d: -6 },
  { x: "-1%", y: "76%", s: 40, tone: "review", r: -20, z: 0.5, t: 8, d: -1 },
];

/**
 * หัวข้อ Hero ขึ้นทีละคำ · ข้อความแปลใช้ <hl>…</hl> ครอบคำที่ขีดเส้นใต้
 * เครื่องหมายวรรคตอนที่ติดท้ายคำไว้ในชิ้นเดียวกัน ไม่ให้ตัดบรรทัดแยกจุดออกจากคำ
 */
function HeroTitle({ text }: { text: string }) {
  const pieces: { nodes: ReactNode[]; hl: boolean }[] = [];
  const out: ReactNode[] = [];
  let gap = true;
  for (const part of text.split(/(<hl>.*?<\/hl>)/)) {
    if (!part) continue;
    const hl = part.match(/^<hl>(.*)<\/hl>$/);
    if (hl) {
      pieces.push({ nodes: [hl[1]], hl: true });
      out.push(pieces.length - 1);
      gap = false;
      continue;
    }
    for (const word of part.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        out.push(word);
        gap = true;
      } else if (!gap && /^[.,!?:;]/.test(word) && pieces.length) {
        pieces[pieces.length - 1]!.nodes.push(word);
      } else {
        pieces.push({ nodes: [word], hl: false });
        out.push(pieces.length - 1);
        gap = false;
      }
    }
  }
  let hlCount = 0;
  return (
    <h1 className={motion.title}>
      {out.map((item, k) => {
        if (typeof item === "string") return <Fragment key={k}>{item}</Fragment>;
        const piece = pieces[item as number]!;
        const [word, ...tail] = piece.nodes;
        return (
          <span key={k} className={motion.word} style={{ "--i": item } as CSSProperties}>
            {piece.hl ? (
              <span className={motion.hl} style={{ "--dd": `${1050 + hlCount++ * 250}ms` } as CSSProperties}>
                {word}
              </span>
            ) : (
              word
            )}
            {tail}
          </span>
        );
      })}
    </h1>
  );
}

/** R1 · Landing (ฟีเจอร์ + ราคา + คำถามที่พบบ่อย) */
export function Landing() {
  const t = useTranslations("saas-pages.landing");
  const features = t.raw("features") as { name: string; description: string }[];
  const faq = t.raw("faq") as { q: string; a: string }[];
  const page = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);
  useReveal(page);

  // แสงม่วง ไทล์ และภาพหน้าจอขยับตามเมาส์ผ่านตัวแปร CSS (ไม่ render ใหม่)
  const follow = (e: PointerEvent<HTMLElement>) => {
    const el = hero.current;
    if (!el || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--gx", `${x * 100}%`);
    el.style.setProperty("--gy", `${y * 100}%`);
    el.style.setProperty("--mx", String((x - 0.5) * 2));
    el.style.setProperty("--my", String((y - 0.5) * 2));
  };
  const rest = () => {
    for (const p of ["--mx", "--my"]) hero.current?.style.setProperty(p, "0");
  };

  return (
    <div ref={page} className={styles.page}>
      <SiteHeader />
      <main>
        <section ref={hero} className={cn(styles.hero, motion.hero)} onPointerMove={follow} onPointerLeave={rest}>
          <div className={motion.tiles} aria-hidden="true">
            {TILES.map((tile, i) => (
              <i
                key={i}
                data-tone={tile.tone}
                style={
                  {
                    "--x": tile.x, "--y": tile.y, "--s": `${tile.s}px`, "--r": `${tile.r}deg`,
                    "--z": tile.z, "--t": `${tile.t}s`, "--d": `${tile.d}s`, "--k": i,
                  } as CSSProperties
                }
              />
            ))}
          </div>
          <div className={cn(styles.wrap, styles.heroRow)}>
            <div className={styles.heroText}>
              <span className={cn(styles.badge, motion.enter)} style={{ "--d": "160ms" } as CSSProperties}>
                <i className={motion.badgeDot} aria-hidden="true" />
                {t("badge")}
              </span>
              <HeroTitle text={t.raw("title") as string} />
              <p className={cn(styles.muted, styles.lead, motion.enter)} style={{ "--d": "720ms" } as CSSProperties}>
                {t("lead")}
              </p>
              <div className={cn(styles.row, motion.enter)} style={{ "--d": "790ms" } as CSSProperties}>
                <Link className={cn(buttonVariants({ variant: "primary" }), styles.btn, styles.shine)} href="/signup">
                  {t("cta")}
                  <svg className={motion.arrow} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 8h9.5M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
                <Link className={cn(buttonVariants(), styles.btn)} href="/pricing">
                  {t("seePrice")}
                </Link>
              </div>
              <div className={cn(styles.muted, styles.small, motion.enter)} style={{ "--d": "860ms" } as CSSProperties}>
                {t("note")}
              </div>
            </div>
            <div className={motion.tilt}>
              <HeroPreview />
            </div>
          </div>
        </section>

        <section id="features" className={styles.section} aria-labelledby="features-title">
          <div className={cn(styles.wrap, styles.stackLg)}>
            <h2 id="features-title" data-reveal="">
              {t("featuresTitle")}
            </h2>
            <div className={cn(styles.features, motion.features)}>
              {features.map((f, i) => (
                <FeatureCard key={f.name} kind={DEMO_ORDER[i] ?? "size"} name={f.name} description={f.description} />
              ))}
            </div>
          </div>
        </section>

        <PricingSection />

        <section id="faq" className={styles.section} aria-labelledby="faq-title">
          <div className={cn(styles.wrap, styles.faqWrap)}>
            <h2 id="faq-title" data-reveal="">
              {t("faqTitle")}
            </h2>
            {faq.map((q) => (
              <details key={q.q} className={styles.faq} data-reveal="">
                <summary>
                  {q.q}
                  <span className={styles.plus} aria-hidden="true" />
                </summary>
                <p className={styles.muted}>{q.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

/** /pricing · ราคาอย่างเดียว พร้อมหัวและท้ายเว็บ */
export function PricingPage() {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <main>
        <PricingSection heading="h1" />
      </main>
      <SiteFooter />
    </div>
  );
}
