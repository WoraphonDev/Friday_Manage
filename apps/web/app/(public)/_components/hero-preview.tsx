"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { EASE, SPRING, play, rise, useReducedMotion } from "./motion";
import styles from "./landing.module.css";

/*
 * ภาพตัวอย่างใน Hero (ตัวเลือก B): งานชุดเดียวกันสลับ Kanban → Timeline → Gantt → Workload
 * Kanban การ์ดเดินจาก To do → Done เอง งานที่เสร็จนานสุดออกจากบอร์ดแล้วมีงานใหม่เข้าคิว จึงวนได้ไม่รู้จบ
 * ข้อมูลเป็นตัวอย่างสมมติ · ข้อความอยู่ใน saas-pages.landing.preview
 */

type Tone = "amber" | "violet" | "teal" | "red" | "blue";
type Who = "p" | "k" | "s";
interface Task {
  tone: Tone;
  who: Who;
  /** ตำแหน่งบนแกน 10 วันทำการของ Timeline / Gantt */
  start?: number;
  len?: number;
  progress?: number;
  late?: boolean;
}

const TASKS: Record<string, Task> = {
  pc: { tone: "amber", who: "k", start: 2, len: 4, progress: 30 },
  er: { tone: "violet", who: "s", start: 6, len: 3, progress: 0 },
  bf: { tone: "teal", who: "p", start: 0, len: 6, progress: 60 },
  ps: { tone: "red", who: "k", start: 0, len: 2, progress: 70, late: true },
  lr: { tone: "teal", who: "s", start: 1, len: 3, progress: 100 },
  lg: { tone: "blue", who: "p", start: 6, len: 4, progress: 0 },
  sd: { tone: "teal", who: "k", start: 7, len: 3, progress: 0 },
  rp: { tone: "blue", who: "s" },
  sa: { tone: "teal", who: "p" },
  pn: { tone: "violet", who: "k" },
  ar: { tone: "amber", who: "p" },
};
const PEOPLE: Who[] = ["p", "k", "s"];
const TIMELINE = ["bf", "lg", "ps", "pc", "sd", "lr", "er"];
const GANTT = ["bf", "pc", "ps", "lr", "lg"];
const DAYS = [9, 10, 11, 12, 13, 16, 17, 18, 19, 20];
const TODAY = 4;
const WEEKS = [46, 47, 48, 49];
const CAPACITY = 5;
const LOAD: Record<Who, number[]> = { p: [4, 5, 3.5, 2], k: [3, 6.5, 4, 1], s: [5, 4.5, 2, 0.5] };

const BOARD_MS = 2400;
const VIEW_MS = 4600;
/** กดแท็บเองแล้วหยุดสลับมุมมองชั่วคราว */
const HOLD_MS = 9000;

interface Board {
  cols: string[][];
  queue: string[];
  phase: number;
}
const START: Board = { cols: [["pc", "er"], ["bf", "ps"], ["lr"], ["lg", "sd"]], queue: ["rp", "sa", "pn", "ar"], phase: 0 };

/** ขั้นถัดไปของบอร์ด: Review → Done, In progress → Review, To do → In progress, เก็บงานเสร็จ (วนตามลำดับ ข้ามขั้นที่ทำไม่ได้) */
function nextBoard(board: Board): { board: Board; moved: string | null; archived: string | null } | null {
  for (let k = 0; k < 4; k++) {
    const phase = (board.phase + k) % 4;
    const cols = board.cols.map((c) => [...c]);
    if (phase < 3) {
      const from = 2 - phase;
      const id = cols[from]!.shift();
      if (!id) continue;
      cols[from + 1]!.push(id);
      return { board: { cols, queue: board.queue, phase: (phase + 1) % 4 }, moved: id, archived: null };
    }
    if (cols[3]!.length < 3) continue;
    const old = cols[3]!.shift()!;
    const [next, ...rest] = board.queue;
    if (next) cols[0]!.push(next);
    return { board: { cols, queue: [...rest, old], phase: 0 }, moved: null, archived: old };
  }
  return null;
}

export function HeroPreview() {
  const t = useTranslations("saas-pages.landing.preview");
  const views = t.raw("views") as string[];
  const columns = t.raw("columns") as string[];
  const reduced = useReducedMotion();
  const [view, setView] = useState(0);
  const [board, setBoard] = useState(START);

  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const rects = useRef<Map<string, DOMRect> | null>(null);
  const moved = useRef<string | null>(null);
  const state = useRef({ board, view, hold: 0, visible: true, mounted: false });
  useEffect(() => {
    state.current.board = board;
    state.current.view = view;
  });

  const title = (id: string) => t(`tasks.${id}.title`);
  const meta = (id: string) => t(`tasks.${id}.meta`);
  const person = (who: Who) => t(`people.${who}`);

  // แถบเลื่อนใต้แท็บ: วัดจากปุ่มจริงเพราะคำแต่ละภาษายาวไม่เท่ากัน
  useLayoutEffect(() => {
    const place = () => {
      const btn = tabs.current?.querySelectorAll("button")[view];
      if (!btn || !indicator.current) return;
      indicator.current.style.width = `${btn.offsetWidth}px`;
      indicator.current.style.transform = `translateX(${btn.offsetLeft}px)`;
    };
    place();
    window.addEventListener("resize", place);
    document.fonts?.ready.then(place).catch(() => {});
    return () => window.removeEventListener("resize", place);
  }, [view]);

  // FLIP: จำตำแหน่งการ์ดก่อนย้าย แล้วเล่นจากตำแหน่งเดิมไปตำแหน่งใหม่
  useLayoutEffect(() => {
    const before = rects.current;
    rects.current = null;
    if (!before) return;
    for (const [id, el] of cards.current) {
      const prev = before.get(id);
      if (!prev) {
        play(el, [{ opacity: 0, transform: "translateY(-10px) scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 480, delay: 120, easing: SPRING, fill: "backwards" });
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) continue;
      const lifted = id === moved.current;
      play(
        el,
        lifted
          ? [
              { transform: `translate(${dx}px,${dy}px)`, boxShadow: "none" },
              { transform: `translate(${dx * 0.45}px,${dy * 0.45 - 16}px) rotate(-3deg) scale(1.06)`, boxShadow: "var(--shadow-menu)", offset: 0.45 },
              { transform: "none", boxShadow: "none" },
            ]
          : [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }],
        { duration: lifted ? 760 : 520, easing: EASE },
      );
    }
    moved.current = null;
  }, [board]);

  // เข้ามุมมองใหม่: ชิ้นในมุมมองนั้นขึ้นทีละชิ้น · ครั้งแรกรอกรอบภาพลอยขึ้นก่อน
  useEffect(() => {
    const vw = stage.current?.querySelector(`[data-view="${view}"]`);
    if (!vw) return;
    const base = state.current.mounted ? 0 : 1000;
    state.current.mounted = true;
    const grow: Keyframe[] = [{ opacity: 0, transform: "scaleX(0)" }, { opacity: 1, transform: "scaleX(1)" }];
    const each = (sel: string, fn: (el: Element, i: number) => void) => vw.querySelectorAll(sel).forEach(fn);
    if (view === 0) each(`.${styles.card}`, (el, i) => play(el, rise(10), { duration: 380, delay: base + 80 + i * 50, easing: EASE, fill: "backwards" }));
    if (view === 1) each(`.${styles.bar}`, (el, i) => play(el, grow, { duration: 560, delay: base + 120 + i * 80, easing: EASE, fill: "backwards" }));
    if (view === 2) each(`.${styles.gbar}, .${styles.diamond}`, (el, i) => play(el, grow, { duration: 560, delay: base + 120 + i * 80, easing: EASE, fill: "backwards" }));
    if (view === 3) {
      each(`.${styles.cell}`, (el, i) => play(el, [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: base + 60 + i * 35, easing: EASE, fill: "backwards" }));
      each(`.${styles.cap} i`, (el, i) => play(el, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 700, delay: base + 300 + i * 35, easing: EASE, fill: "backwards" }));
    }
  }, [view]);

  // หยุด loop เมื่อภาพพ้นจอหรือสลับแท็บเบราว์เซอร์ ประหยัดแบตเตอรี่
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      state.current.visible = !!entry?.isIntersecting;
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced) return;
    const live = () => state.current.visible && !document.hidden;
    const commit = (plan: NonNullable<ReturnType<typeof nextBoard>>) => {
      if (state.current.view === 0) rects.current = new Map([...cards.current].map(([id, el]) => [id, el.getBoundingClientRect()]));
      moved.current = plan.moved;
      setBoard(plan.board);
    };
    const tick = () => {
      if (!live() || state.current.view !== 0) return;
      const plan = nextBoard(state.current.board);
      if (!plan) return;
      const leaving = plan.archived ? cards.current.get(plan.archived) : null;
      const out = play(leaving, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }], { duration: 260, easing: "ease-in", fill: "forwards" });
      if (out) out.finished.then(() => commit(plan), () => commit(plan));
      else commit(plan);
    };
    const cycle = () => {
      if (live() && Date.now() > state.current.hold) setView((v) => (v + 1) % views.length);
    };
    const a = window.setInterval(tick, BOARD_MS);
    const b = window.setInterval(cycle, VIEW_MS);
    return () => {
      window.clearInterval(a);
      window.clearInterval(b);
    };
  }, [reduced, views.length]);

  const avatar = (who: Who) => (
    <span className={styles.av} data-who={who}>
      {person(who)}
    </span>
  );
  const days = (label: string, cls?: string) => (
    <div className={cn(styles.trow, styles.hd, cls)}>
      <span className={styles.lbl}>{label}</span>
      <div className={cn(styles.track, styles.days)}>
        {DAYS.map((d, i) => (
          <span key={d} className={i === TODAY ? styles.today : undefined}>
            {d}
          </span>
        ))}
      </div>
    </div>
  );
  const todayMark = <span className={styles.todayMark} style={{ gridColumn: TODAY + 1 }} />;
  const span = (task: Task) => ({ gridColumn: `${(task.start ?? 0) + 1} / span ${task.len ?? 1}` });

  return (
    <div ref={root} className={styles.preview} role="group" aria-label={t("label")}>
      <div className={styles.pvBar}>
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <div ref={tabs} className={styles.tabs}>
          <span ref={indicator} className={styles.tabInd} aria-hidden="true" />
          {views.map((name, i) => (
            <button
              key={name}
              type="button"
              aria-pressed={view === i}
              onClick={() => {
                state.current.hold = Date.now() + HOLD_MS;
                setView(i);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div ref={stage} className={styles.stage} aria-hidden="true">
        <div className={cn(styles.vw, view === 0 && styles.on)} data-view="0">
          <div className={styles.kanban}>
            {board.cols.map((ids, c) => (
              <div key={columns[c]} className={styles.kcol}>
                <header>
                  {columns[c]}
                  <em key={ids.length}>{ids.length}</em>
                </header>
                <div className={styles.klist}>
                  {ids.map((id) => {
                    const task = TASKS[id]!;
                    return (
                      <div
                        key={id}
                        ref={(el) => {
                          if (el) cards.current.set(id, el);
                          else cards.current.delete(id);
                        }}
                        className={cn(styles.card, task.late && styles.late)}
                        data-tone={task.tone}
                      >
                        <i />
                        {title(id)}
                        <small>
                          {meta(id)}
                          {avatar(task.who)}
                        </small>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={cn(styles.vw, view === 1 && styles.on)} data-view="1">
          <div className={styles.tgrid}>
            {days(t("month"))}
            {PEOPLE.map((who) => (
              <div key={who} className={styles.trow}>
                {avatar(who)}
                <div className={styles.track}>
                  {todayMark}
                  {TIMELINE.filter((id) => TASKS[id]!.who === who).map((id) => {
                    const task = TASKS[id]!;
                    return (
                      <span key={id} className={cn(styles.bar, task.late && styles.late)} data-tone={task.tone} style={span(task)}>
                        {title(id)}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={cn(styles.vw, view === 2 && styles.on)} data-view="2">
          <div className={styles.tgrid}>
            {days(t("task"), styles.wide)}
            {GANTT.map((id) => {
              const task = TASKS[id]!;
              return (
                <div key={id} className={cn(styles.trow, styles.wide)}>
                  <span className={styles.gName}>{title(id)}</span>
                  <div className={styles.track}>
                    {todayMark}
                    <span className={cn(styles.gbar, task.late && styles.late)} data-tone={task.tone} style={span(task)}>
                      <i style={{ width: `${task.progress ?? 0}%` }} />
                    </span>
                  </div>
                </div>
              );
            })}
            <div className={cn(styles.trow, styles.wide)}>
              <span className={cn(styles.gName, styles.dim)}>{t("milestone")}</span>
              <div className={styles.track}>
                {todayMark}
                <span className={styles.diamond} style={{ gridColumn: DAYS.length }} />
              </div>
            </div>
          </div>
        </div>

        <div className={cn(styles.vw, view === 3 && styles.on)} data-view="3">
          <div className={styles.wl}>
            <span />
            {WEEKS.map((w) => (
              <span key={w} className={styles.wh}>
                {t("week", { n: w })}
              </span>
            ))}
            {PEOPLE.map((who) => [
              <span key={who} className={styles.wlWho}>
                {avatar(who)}
              </span>,
              ...LOAD[who].map((v, i) => (
                <div key={`${who}-${WEEKS[i]}`} className={cn(styles.cell, v > CAPACITY && styles.over)}>
                  <b>
                    {v} <small>{t("capacity")}</small>
                  </b>
                  <div className={styles.cap}>
                    <i style={{ width: `${Math.min(v / CAPACITY, 1) * 100}%` }} />
                  </div>
                  {v > CAPACITY && <span className={styles.overTag}>{t("over")}</span>}
                </div>
              )),
            ])}
            <div className={styles.wlFoot}>
              <span>{t("workloadNote")}</span>
              <span>{t("workloadAlert")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
