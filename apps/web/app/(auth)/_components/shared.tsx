"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { FridayLoader, FridayLogo } from "@/components/brand/friday-logo";
import { Button, buttonVariants } from "@/components/ui";
import { ApiError, supportId } from "@/lib/api";
import { cn } from "@/lib/utils";
import styles from "./auth.module.css";

export const NS = "auth-onboarding";

export function Logo({
  href = "/login",
  tone = "light",
  size = "md",
}: {
  href?: string;
  tone?: "light" | "dark";
  size?: "md" | "lg";
}) {
  const t = useTranslations(NS);
  return (
    <Link href={href} className={styles.logo}>
      <FridayLogo tone={tone} size={size} label={t("brand.name")} />
    </Link>
  );
}

/** ผู้ใช้ตั้ง "ลดการเคลื่อนไหว" ไว้หรือไม่ · jsdom ไม่มี matchMedia จึงถือว่าไม่ได้ตั้ง */
export function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** สั่นซ้ายขวาสั้น ๆ เมื่อกรอกผิด · ไม่มี Web Animations (jsdom) หรือลดการเคลื่อนไหวก็ข้าม */
export function shake(element: HTMLElement | null) {
  if (!element?.animate || prefersReducedMotion()) return;
  element.animate(
    [0, -8, 7, -5, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: 380, easing: "ease-out" },
  );
}

/** Animation จะเล่นจริงไหม · jsdom ไม่มี Web Animations และผู้ใช้ที่ลดการเคลื่อนไหวไม่ต้องรอ */
function animates() {
  return typeof document !== "undefined" && !!document.body.animate && !prefersReducedMotion();
}

/** รอให้ animation เล่นจบก่อนทำขั้นต่อไป · ถ้าไม่มี animation ก็ไปต่อทันที */
export function motionPause(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, animates() ? ms : 0));
}

/** เลื่อนเนื้อหาเดิมออกทางซ้ายก่อนเปลี่ยนขั้น · คืน animation ไว้ยกเลิกหลังวาดขั้นใหม่แล้ว */
export async function slideOut(element: HTMLElement | null) {
  if (!element || !animates()) return null;
  const animation = element.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-28px)" }],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  );
  await animation.finished.catch(() => undefined);
  return animation;
}

/** ปุ่มเขียวค้างให้เห็นเครื่องหมายถูกวาดจบ แล้วจึงเปลี่ยนเป็นหน้าจอสำเร็จ (ตาม mockup) */
export const SUBMIT_DONE_MS = 650;
/** แถบในหน้าจอสำเร็จเต็มเมื่อ 0.45 + 1.6 วินาที (ตรงกับ .successBar) แล้วจึงเปลี่ยนหน้า */
export const LOGIN_SUCCESS_MS = 2050;

/** หน้าจอหลังเข้าสู่ระบบสำเร็จ: logo ประกอบตัวแล้วเด้งวน + แถบสีไทล์วิ่งจนเต็ม */
export function LoginSuccess() {
  const t = useTranslations(NS);
  return (
    <div className={styles.success} role="status">
      <FridayLoader className={styles.successMark} />
      <Heading title={t("login.success.title")} subtitle={t("login.success.subtitle")} />
      <div className={styles.successBar} aria-hidden="true">
        <i />
      </div>
    </div>
  );
}

/* ไทล์สีของ logo ลอยอยู่ด้านซ้ายของพื้นหลัง (ผู้ใช้เลือกแบบ B จาก mockup 2026-11-14)
 * z = ระยะที่ขยับตามเมาส์ · t = วินาทีต่อรอบลอย · b = เบลอให้ดูอยู่ไกล */
const BACKDROP = [
  { x: 70, y: 6, s: 120, c: "review", r: -14, z: 0.9, t: 10, d: 0 },
  { x: 84, y: 34, s: 72, c: "progress", r: 12, z: 0.6, t: 8, d: -3 },
  { x: 62, y: 62, s: 96, c: "done", r: -6, z: 1, t: 11, d: -5, o: 0.85 },
  { x: 88, y: 78, s: 56, c: "overdue", r: 20, z: 0.5, t: 7, d: -2 },
  { x: 52, y: 20, s: 26, c: "overdue", r: 8, z: 0.3, t: 9, d: -6, b: 1.5, o: 0.6 },
  { x: 76, y: 52, s: 22, c: "review", r: -20, z: 0.25, t: 8, d: -1, b: 1.5, o: 0.55 },
  { x: 46, y: 86, s: 34, c: "progress", r: -10, z: 0.35, t: 10, d: -4, b: 2, o: 0.5 },
  { x: 94, y: 14, s: 18, c: "done", r: 14, z: 0.2, t: 7, d: -7, b: 2, o: 0.5 },
];

function Backdrop() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      {BACKDROP.map((tile, index) => (
        <i
          key={index}
          style={
            {
              "--x": `${tile.x}%`,
              "--y": `${tile.y}%`,
              "--s": `${tile.s}px`,
              "--c": `var(--status-${tile.c}-bg)`,
              "--r": `${tile.r}deg`,
              "--z": tile.z,
              "--t": `${tile.t}s`,
              "--d": `${tile.d}s`,
              "--b": `${tile.b ?? 0}px`,
              "--o": tile.o ?? 0.9,
              "--in": `${0.2 + index * 0.07}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** แสงม่วงและไทล์ลอยขยับตามเมาส์ · เขียนค่าเป็นตัวแปร CSS ทีละเฟรม ไม่ทำให้ React render ใหม่ */
function usePointerParallax(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        element.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
        element.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
        element.style.setProperty("--mx", ((x - 0.5) * 2).toFixed(3));
        element.style.setProperty("--my", ((y - 0.5) * 2).toFixed(3));
      });
    };
    const leave = () => {
      element.style.setProperty("--mx", "0");
      element.style.setProperty("--my", "0");
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
    };
  }, [ref]);
}

const FEED = [
  { key: "commit", tone: "review" },
  { key: "move", tone: "progress" },
  { key: "tests", tone: "done" },
  { key: "due", tone: "overdue" },
] as const;

/** กล่องกิจกรรมตัวอย่างในแผงซ้ายของ Login · เปลี่ยนทุก 3 วินาที (เป็นภาพประกอบ จึงซ่อนจากโปรแกรมอ่านหน้าจอ) */
function BrandFeed() {
  const t = useTranslations(NS);
  const [{ current, previous }, setFeed] = useState({ current: 0, previous: -1 });
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = setInterval(() => setFeed(({ current: now }) => ({ current: (now + 1) % FEED.length, previous: now })), 3000);
    return () => clearInterval(timer);
  }, []);
  const item = (index: number, leaving: boolean) => {
    const { key, tone } = FEED[index];
    return (
      <div key={`${index}-${leaving}`} className={styles.feedItem} data-leaving={leaving || undefined}>
        <span className={styles.feedAvatar} style={{ "--c": `var(--status-${tone}-bg)`, "--ink": `var(--status-${tone}-fg)` } as CSSProperties}>
          {t(`brand.feed.${key}.who`)}
        </span>
        <span className={styles.feedText}>
          <span>{t(`brand.feed.${key}.text`)}</span>
          <small>{t(`brand.feed.${key}.when`)}</small>
        </span>
      </div>
    );
  };
  return (
    <div className={styles.feed} aria-hidden="true">
      {previous >= 0 && item(previous, true)}
      {item(current, false)}
    </div>
  );
}

/** J1 / J2 · พื้นเข้มผืนเดียวทั้งจอ แผงแบรนด์ด้านซ้าย ฟอร์มเป็นการ์ดลอยด้านขวา (มือถือเรียงบนลงล่าง) */
export function SplitLayout({
  variant,
  children,
}: {
  variant: "login" | "signup";
  children: ReactNode;
}) {
  const t = useTranslations(NS);
  const root = useRef<HTMLDivElement>(null);
  usePointerParallax(root);
  return (
    <div className={styles.split} ref={root}>
      <Backdrop />
      <section className={styles.brand} aria-label={t("brand.name")}>
        <Logo tone="dark" size="lg" />
        <div className={styles.brandBody}>
          <h2 className={styles.brandTitle}>
            {variant === "login"
              ? t.rich("brand.loginTitle", { hl: (chunks) => <span className={styles.hl}>{chunks}</span> })
              : t("brand.signupTitle")}
          </h2>
          {variant === "login" ? (
            <>
              <ul className={styles.brandList}>
                <li>{t("brand.loginPoints.views")}</li>
                <li>{t("brand.loginPoints.git")}</li>
                <li>{t("brand.loginPoints.workload")}</li>
              </ul>
              <BrandFeed />
            </>
          ) : (
            <ol className={styles.brandSteps} style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {(["account", "workspace", "project"] as const).map((key, index) => (
                <li key={key} className={styles.brandStep}>
                  <span className={styles.brandStepNo} data-on={index === 0}>
                    {index + 1}
                  </span>
                  <span>{t(`brand.signupSteps.${key}`)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className={styles.brandFoot}>
          {variant === "login" ? (
            <>
              {t("brand.copyright")} · <Link href="/legal/privacy">{t("brand.privacy")}</Link> ·{" "}
              <Link href="/legal/terms">{t("brand.terms")}</Link>
            </>
          ) : (
            t("brand.noCard")
          )}
        </div>
      </section>
      <section className={styles.formSide}>
        <div className={styles.box}>{children}</div>
      </section>
    </div>
  );
}

/** ปุ่มส่งฟอร์มเข้าสู่ระบบ · ระหว่างรอเป็นไทล์ 4 สีกระโดด · สำเร็จเป็นสีเขียวพร้อมเครื่องหมายถูกระหว่างเปลี่ยนหน้า */
export function SubmitButton({
  busy,
  done,
  disabled,
  children,
}: {
  busy: boolean;
  done?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations(NS);
  const state = done ? "done" : busy ? "busy" : "idle";
  return (
    <Button
      type="submit"
      variant="primary"
      className={cn(styles.button, styles.submit)}
      data-state={state}
      aria-busy={busy || undefined}
      disabled={busy || done || disabled}
    >
      <span className={styles.submitLabel}>{children}</span>
      <span className={styles.submitBusy} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className={styles.submitDone} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M4.5 10.5 8.5 14l7-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {busy && <span className="sr-only">{t("common.working")}</span>}
    </Button>
  );
}

/** J3 / J4 · การ์ดกลางจอบนพื้นเทา */
export function CardLayout({
  children,
  wide,
  footer,
}: {
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  return (
    <main className={styles.cardPage}>
      <Logo />
      <div className={cn(styles.card, wide && styles.cardWide)}>{children}</div>
      {footer}
    </main>
  );
}

export function Heading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className={styles.heading}>
      <h1>{title}</h1>
      {subtitle && <div className={styles.muted}>{subtitle}</div>}
    </div>
  );
}

/** ข้อความผิดพลาดในฟอร์ม · แสดง requestId ให้ผู้ใช้คัดลอกส่งทีมช่วยเหลือ (M1) */
export function FormAlert({
  error,
  message,
  tone = "error",
  children,
}: {
  error?: unknown;
  message?: ReactNode;
  tone?: "error" | "info" | "success";
  children?: ReactNode;
}) {
  const t = useTranslations(NS);
  const apiError = error instanceof ApiError ? error : null;
  const text = message ?? (error instanceof Error ? error.message : undefined);
  if (!text && !children) return null;
  const Icon = tone === "error" ? CircleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div
      className={cn(
        styles.alert,
        tone === "info" && styles.alertInfo,
        tone === "success" && styles.alertSuccess,
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon size={18} aria-hidden="true" />
      <div className={styles.alertBody}>
        {text && <span>{text}</span>}
        {children}
        {supportId(apiError) && (
          <code className={styles.requestId}>
            {t("common.requestId", { id: supportId(apiError) ?? "" })}
          </code>
        )}
      </div>
    </div>
  );
}

/** ช่องรหัส 6 หลัก · วางทั้งรหัสได้ · Backspace ย้อนช่อง */
export function OtpInput({
  value,
  onChange,
  invalid,
  autoFocus,
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
}) {
  const t = useTranslations(NS);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  function set(index: number, digit: string) {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join("").slice(0, 6));
  }
  function type(index: number, raw: string) {
    const clean = raw.replace(/\D/g, "");
    if (!clean) return set(index, "");
    if (clean.length > 1) return fill(clean, index);
    set(index, clean);
    refs.current[Math.min(index + 1, 5)]?.focus();
  }
  function fill(text: string, from = 0) {
    const next = digits.slice(0, from).concat(text.split("")).slice(0, 6);
    onChange(next.join(""));
    refs.current[Math.min(next.length, 5)]?.focus();
  }
  function key(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      set(index - 1, "");
      refs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowLeft" && index > 0) refs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < 5) refs.current[index + 1]?.focus();
  }
  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!text) return;
    event.preventDefault();
    fill(text);
  }
  return (
    <div
      className={styles.otp}
      role="group"
      aria-label={t("common.otpGroup")}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={index === 0 ? 6 : 1}
          value={digit}
          data-filled={digit ? true : undefined}
          aria-label={t("common.otpDigit", { n: index + 1 })}
          onChange={(event) => type(index, event.target.value)}
          onKeyDown={(event) => key(index, event)}
          onPaste={paste}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  );
}

/** ช่องรหัสผ่านพร้อมปุ่มแสดง/ซ่อน · ใช้สไตล์ .input ของ UI kit */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  labelExtra,
  error,
  invalid,
  hint,
  name = "password",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  labelExtra?: ReactNode;
  error?: string;
  /** ทำเครื่องหมายว่าผิดโดยไม่มีข้อความใต้ช่อง (ข้อความอยู่ใน alert ด้านบน) */
  invalid?: boolean;
  hint?: ReactNode;
  name?: string;
  autoFocus?: boolean;
}) {
  const t = useTranslations(NS);
  const id = useId();
  const [show, setShow] = useState(false);
  const describedBy = error || hint ? `${id}-description` : undefined;
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label htmlFor={id}>{label}</label>
        {labelExtra}
      </div>
      <span className={styles.passwordWrap}>
        <input
          id={id}
          name={name}
          className={cn("input", styles.input)}
          type={show ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          aria-invalid={error || invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={styles.reveal}
          aria-label={show ? t("common.hidePassword") : t("common.showPassword")}
          aria-pressed={show}
          onClick={() => setShow(!show)}
        >
          {/* ซ้อนสองคำแล้วเลื่อนสลับกัน ชื่อปุ่มสำหรับโปรแกรมอ่านหน้าจอมาจาก aria-label */}
          <span aria-hidden="true">{t("common.show")}</span>
          <span aria-hidden="true">{t("common.hide")}</span>
        </button>
      </span>
      {(error || hint) && (
        <span id={describedBy} className={error ? "field-error" : undefined} role={error ? "alert" : undefined}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export type StrengthLevel = "weak" | "fair" | "good" | "strong";
export interface PasswordPolicy {
  minLength: number;
  requireSpecial: boolean;
}
export const DEFAULT_POLICY: PasswordPolicy = { minLength: 8, requireSpecial: false };

/** กติกาเดียวกับ API (J2: อย่างน้อย 8 ตัว มีตัวพิมพ์ใหญ่และตัวเลข · อักขระพิเศษตามนโยบาย Workspace) */
export function checkPassword(value: string, policy: PasswordPolicy = DEFAULT_POLICY) {
  const rules = {
    length: value.length >= policy.minLength,
    upper: /[A-Z]/.test(value),
    digit: /[0-9]/.test(value),
    special: /[^A-Za-z0-9]/.test(value),
  };
  const valid = rules.length && rules.upper && rules.digit && (!policy.requireSpecial || rules.special);
  const score = Object.values(rules).filter(Boolean).length;
  const level: StrengthLevel = !valid ? (score <= 2 ? "weak" : "fair") : score === 4 && value.length >= 12 ? "strong" : "good";
  return { rules, valid, score, level };
}

export function PasswordStrength({
  value,
  policy = DEFAULT_POLICY,
  showMeter = true,
}: {
  value: string;
  policy?: PasswordPolicy;
  showMeter?: boolean;
}) {
  const t = useTranslations(NS);
  const { rules, level, score } = checkPassword(value, policy);
  const bars = level === "strong" ? 4 : level === "good" ? 3 : level === "fair" ? 2 : value ? 1 : 0;
  return (
    <>
      {showMeter && (
        <>
          <span className={styles.meter} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} data-on={i < bars} data-level={level} />
            ))}
          </span>
          {value && (
            <span className={styles.strength} data-level={level} aria-live="polite" data-score={score}>
              {t("password.strength", { level: t(`password.levels.${level}`) })}
            </span>
          )}
        </>
      )}
      <ul className={styles.rules} aria-label={t("password.rulesLabel")}>
        {(["length", "upper", "digit", "special"] as const).map((rule) => (
          <li key={rule} className={styles.rule} data-ok={rules[rule]}>
            <span aria-hidden="true">{rules[rule] ? "✓" : "○"}</span>
            {rule === "length"
              ? t("password.rules.length", { n: policy.minLength })
              : rule === "special" && !policy.requireSpecial
                ? t("password.rules.specialOptional")
                : t(`password.rules.${rule}`)}
          </li>
        ))}
      </ul>
    </>
  );
}

/** ปุ่ม OAuth เป็นลิงก์เต็มหน้า: API redirect ไปผู้ให้บริการแล้วกลับมาที่หน้าเว็บ */
export function oauthHref(provider: "google" | "microsoft", next?: string, remember?: boolean) {
  const params = new URLSearchParams();
  if (next) params.set("next", next);
  if (remember) params.set("remember", "true");
  const query = params.toString();
  return `/api/v1/auth/oauth/${provider}/start${query ? `?${query}` : ""}`;
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#EA4335" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="sans-serif">
        G
      </text>
    </svg>
  );
}
export function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="9" height="9" fill="#F25022" />
      <rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
      <rect x="2" y="13" width="9" height="9" fill="#00A4EF" />
      <rect x="13" y="13" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function OAuthLink({
  provider,
  label,
  next,
  remember,
}: {
  provider: "google" | "microsoft";
  label: string;
  next?: string;
  remember?: boolean;
}) {
  return (
    <a className={cn(buttonVariants(), styles.button, styles.oauth)} href={oauthHref(provider, next, remember)}>
      <span className={styles.oauthIcon}>{provider === "google" ? <GoogleIcon /> : <MicrosoftIcon />}</span>
      {label}
    </a>
  );
}

/** นับถอยหลังสำหรับปุ่มส่งใหม่ (API ให้ส่งใหม่ได้ทุก 60 วินาที) */
export function useCountdown(initial = 0) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const label = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return { left, label, start: setLeft };
}

/** กันการพาออกนอกเว็บ: รับเฉพาะ path ภายในที่ขึ้นต้นด้วย / ตัวเดียว */
export function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (value.startsWith("/login") || value.startsWith("/signup")) return null;
  return value;
}

export { styles };
