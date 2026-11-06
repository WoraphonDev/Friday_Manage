// คำนวณ Critical path, Slack และ Auto-schedule บนแกน "วันทำการ" (ข้ามวันหยุดและเสาร์–อาทิตย์ตามปฏิทินโปรเจกต์)
import type { WorkCalendar } from '../projects/calendar.js';

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';

export interface Node {
  id: string;
  start: string;
  end: string;
}
export interface Edge {
  pred: string;
  succ: string;
  type: DepType;
  /** วันทำการ (ติดลบ = เริ่มทับก่อน) */
  lag: number;
}

const MAX_DAYS = 20_000;

/** แกนวันทำการ: ลำดับที่ 0, 1, 2 … ของวันทำการนับจากวันฐาน · แปลงไป-กลับกับวันที่ได้ */
export class Axis {
  private readonly days: string[] = [];
  private cursor: string;

  constructor(
    private readonly cal: WorkCalendar,
    base: string,
  ) {
    this.cursor = base;
  }

  private step() {
    const d = new Date(`${this.cursor}T00:00:00Z`);
    if (this.cal.isWorkingDay(this.cursor)) this.days.push(this.cursor);
    d.setUTCDate(d.getUTCDate() + 1);
    this.cursor = d.toISOString().slice(0, 10);
  }

  private fillDate(date: string) {
    let guard = 0;
    while (this.cursor <= date && guard++ < MAX_DAYS) this.step();
  }

  private fillIdx(i: number) {
    let guard = 0;
    while (this.days.length <= i && guard++ < MAX_DAYS) this.step();
  }

  /** ลำดับของวันทำการ: 'next' = วันทำการแรกที่ ≥ date · 'prev' = วันทำการสุดท้ายที่ ≤ date */
  idx(date: string, mode: 'next' | 'prev'): number {
    this.fillDate(date);
    let lo = 0;
    let hi = this.days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid]! <= date) lo = mid + 1;
      else hi = mid;
    }
    // lo = จำนวนวันทำการที่ ≤ date
    if (mode === 'prev') return Math.max(lo - 1, 0);
    if (lo > 0 && this.days[lo - 1] === date) return lo - 1;
    this.fillIdx(lo);
    return lo;
  }

  at(i: number): string {
    this.fillIdx(i);
    return this.days[Math.max(i, 0)]!;
  }
}

interface Timed extends Node {
  s: number;
  f: number;
  dur: number;
}

function time(axis: Axis, n: Node): Timed {
  const s = axis.idx(n.start, 'next');
  const f = Math.max(axis.idx(n.end, 'prev'), s);
  return { ...n, s, f, dur: f - s + 1 };
}

export class DependencyCycleError extends Error {
  constructor(readonly ids: string[]) {
    super('dependency cycle');
  }
}

/** เรียงตามลำดับพึ่งพา (predecessor ก่อน) · วนเป็นวงโยน DependencyCycleError */
function topo(ids: string[], edges: Edge[]): string[] {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    indeg.set(e.succ, (indeg.get(e.succ) ?? 0) + 1);
    out.set(e.pred, [...(out.get(e.pred) ?? []), e.succ]);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const nx of out.get(id) ?? []) {
      indeg.set(nx, indeg.get(nx)! - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  if (order.length !== ids.length) throw new DependencyCycleError(ids.filter((id) => !order.includes(id)));
  return order;
}

/** วันเริ่มที่ต้องไม่ก่อน (index) เมื่อ predecessor อยู่ที่ (ps, pf) และงานนี้ยาว dur วันทำการ */
function requiredStart(e: Edge, ps: number, pf: number, dur: number): number {
  switch (e.type) {
    case 'FS':
      return pf + 1 + e.lag;
    case 'SS':
      return ps + e.lag;
    case 'FF':
      return pf + e.lag - dur + 1;
    case 'SF':
      return ps + e.lag - dur + 1;
  }
}

export interface CriticalResult {
  /** slack ต่องาน (วันทำการ) · ติดลบ = แผนขัดกับ Dependency */
  slack: Map<string, number>;
  critical: Set<string>;
  /** Dependency ที่อยู่บนเส้นวิกฤต (ทั้งสองปลายวิกฤตและไม่มีช่องว่าง) */
  criticalEdges: Set<string>;
  /** รหัสงานบนเส้นวิกฤตเรียงตามวันเริ่ม */
  path: string[];
}

export const edgeKey = (e: Pick<Edge, 'pred' | 'succ'>) => `${e.pred}>${e.succ}`;

/**
 * Critical path แบบ CPM โดยใช้วันตามแผนเป็น Early dates แล้วคำนวณ Late dates ย้อนจากวันจบของโครงข่าย
 * งานวิกฤต = slack ≤ 0 และอยู่ในโครงข่าย Dependency (งานเดี่ยวที่ไม่มี Dependency ไม่นับเป็นเส้นทาง)
 */
export function criticalPath(axis: Axis, nodes: Node[], edges: Edge[]): CriticalResult {
  const ids = nodes.map((n) => n.id);
  const set = new Set(ids);
  const es = edges.filter((e) => set.has(e.pred) && set.has(e.succ));
  const t = new Map(nodes.map((n) => [n.id, time(axis, n)]));
  const order = topo(ids, es);
  const outgoing = new Map<string, Edge[]>();
  for (const e of es) outgoing.set(e.pred, [...(outgoing.get(e.pred) ?? []), e]);

  const projectEnd = Math.max(-1, ...[...t.values()].map((x) => x.f));
  const lf = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const me = t.get(id)!;
    let late = projectEnd;
    for (const e of outgoing.get(id) ?? []) {
      const sc = t.get(e.succ)!;
      const lfs = lf.get(e.succ)!;
      const lss = lfs - sc.dur + 1;
      let lfp: number;
      if (e.type === 'FS') lfp = lss - 1 - e.lag;
      else if (e.type === 'SS') lfp = lss - e.lag + me.dur - 1;
      else if (e.type === 'FF') lfp = lfs - e.lag;
      else lfp = lfs - e.lag + me.dur - 1;
      late = Math.min(late, lfp);
    }
    lf.set(id, late);
  }

  const linked = new Set(es.flatMap((e) => [e.pred, e.succ]));
  const slack = new Map<string, number>();
  const critical = new Set<string>();
  for (const id of ids) {
    const sl = lf.get(id)! - t.get(id)!.f;
    slack.set(id, sl);
    if (sl <= 0 && linked.has(id)) critical.add(id);
  }
  const criticalEdges = new Set<string>();
  for (const e of es) {
    if (!critical.has(e.pred) || !critical.has(e.succ)) continue;
    const p = t.get(e.pred)!;
    const sc = t.get(e.succ)!;
    if (sc.s - requiredStart(e, p.s, p.f, sc.dur) <= 0) criticalEdges.add(edgeKey(e));
  }
  const path = [...critical].sort((a, b) => t.get(a)!.s - t.get(b)!.s || t.get(a)!.f - t.get(b)!.f);
  return { slack, critical, criticalEdges, path };
}

export interface Shift {
  id: string;
  start: string;
  end: string;
  /** เลื่อนไปกี่วันทำการ */
  shiftDays: number;
  /** งานที่ทำให้ต้องเลื่อน */
  because: string[];
}

/**
 * Auto-schedule: เลื่อนเฉพาะงานที่ละเมิด Dependency ไปข้างหลัง (ไม่ดึงงานให้เร็วขึ้น) คงจำนวนวันทำการเท่าเดิม
 * งานที่เสร็จแล้ว (`fixed`) เป็นตัวยึด ไม่ถูกเลื่อน · เลื่อนต่อเป็นทอดตามลำดับพึ่งพา
 */
export function autoSchedule(axis: Axis, nodes: Node[], edges: Edge[], fixed: Set<string>): Shift[] {
  const ids = nodes.map((n) => n.id);
  const set = new Set(ids);
  const es = edges.filter((e) => set.has(e.pred) && set.has(e.succ));
  const t = new Map(nodes.map((n) => [n.id, time(axis, n)]));
  const incoming = new Map<string, Edge[]>();
  for (const e of es) incoming.set(e.succ, [...(incoming.get(e.succ) ?? []), e]);
  const shifts: Shift[] = [];
  for (const id of topo(ids, es)) {
    if (fixed.has(id)) continue;
    const me = t.get(id)!;
    let need = me.s;
    let because: string[] = [];
    for (const e of incoming.get(id) ?? []) {
      const p = t.get(e.pred)!;
      const r = requiredStart(e, p.s, p.f, me.dur);
      if (r > need) {
        need = r;
        because = [e.pred];
      } else if (r === need && r > me.s) because.push(e.pred);
    }
    if (need > me.s) {
      shifts.push({ id, start: axis.at(need), end: axis.at(need + me.dur - 1), shiftDays: need - me.s, because });
      me.f = need + me.dur - 1;
      me.s = need;
    }
  }
  return shifts;
}
