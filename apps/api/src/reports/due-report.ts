// รายงาน "งานที่จะเสร็จ" (ผู้ใช้ขอ 2026-11-17): งานและแผน (Module › Phase) ที่ Plan End อยู่ในช่วงที่เลือก
// กรองตาม Module · BA · SA · DEV · ใช้ Plan End ทุกโปรเจกต์ รวมโปรเจกต์ที่แยก Dev / QA (ผู้ใช้ยืนยันตาม mockup)
import { schema as s, type Tx } from '@friday/db';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadPeople, type Person } from '../common/people.js';
import { addDays } from '../projects/calendar.js';
import { isOpen, type Item, type PlanData, round1 } from './plan-data.js';

/** หน้าต่างวัดอัตราเสร็จจริงเพื่อคาดวันจบ · ตรงกับ Plan vs Actual */
const VELOCITY_DAYS = 28;
/** ช่วงยาวสุดที่เลือกได้ กันคำขอที่วนปฏิทินนานเกิน */
const MAX_RANGE_DAYS = 366;
/** ความคืบหน้าตามจริงต่ำกว่าที่ควรเป็นตามวันทำการที่ผ่านไปเกินเท่านี้ = เสี่ยง */
const RISK_GAP_PCT = 30;
export const NO_MODULE = 'none';

const isoDate = z.iso.date();
const idList = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), z.array(z.string().max(64)).max(200)).optional();
export const DueQuery = z
  .object({ from: isoDate, to: isoDate, modules: idList, ba: idList, sa: idList, dev: idList })
  .refine((q) => q.from <= q.to, { message: 'วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= MAX_RANGE_DAYS * 86_400_000, { message: `เลือกช่วงได้ไม่เกิน ${MAX_RANGE_DAYS} วัน`, path: ['to'] });
export type DueQuery = z.infer<typeof DueQuery>;

export type TaskState = 'done' | 'late' | 'at_risk' | 'on_track';

type Project = { id: string; key: string; name: string };

/** ตรงกับตัวกรองทุกข้อ · ตัวกรองว่าง = ไม่กรอง · DEV ตรงเมื่อมีผู้รับผิดชอบคนใดคนหนึ่งที่เลือก */
function matches(i: Item, q: DueQuery) {
  if (q.modules?.length && !q.modules.includes(i.moduleId ?? NO_MODULE)) return false;
  if (q.ba?.length && !(i.baId && q.ba.includes(i.baId))) return false;
  if (q.sa?.length && !(i.saId && q.sa.includes(i.saId))) return false;
  if (q.dev?.length && !i.assigneeIds.some((id) => q.dev!.includes(id))) return false;
  return true;
}

/** วันทำการระหว่างแผนกับคาดการณ์ (+ = ช้า) · นับแบบเดียวกับ Timeline: วันเดียวกัน = 0 */
function slipWorkingDays(plan: PlanData, planned: string, forecast: string) {
  if (forecast === planned) return 0;
  return forecast > planned ? plan.cal.workingDaysIn(addDays(planned, 1), forecast) : -plan.cal.workingDaysIn(addDays(forecast, 1), planned);
}

export async function dueReport(tx: Tx, project: Project, plan: PlanData, q: DueQuery, now: string) {
  const cal = plan.cal;
  const phases = await tx.select({ id: s.phases.id, name: s.phases.name, moduleId: s.phases.moduleId, sort: s.phases.sort }).from(s.phases).where(eq(s.phases.projectId, project.id)).orderBy(asc(s.phases.sort), asc(s.phases.name));
  const moduleRows = await tx.select({ id: s.modules.id, name: s.modules.name, color: s.modules.color, sort: s.modules.sort }).from(s.modules).where(eq(s.modules.projectId, project.id)).orderBy(asc(s.modules.sort), asc(s.modules.name));
  const moduleOf = new Map(moduleRows.map((m) => [m.id, m]));
  const phaseOf = new Map(phases.map((p) => [p.id, p]));
  const keyOf = new Map(plan.items.map((i) => [i.id, i.key]));

  // ตัวเลือกในตัวกรองมาจากงานทั้งโปรเจกต์ (ไม่ใช่แค่ช่วงวันที่) เลือกค้างไว้แล้วเปลี่ยนช่วงได้โดยตัวเลือกไม่หาย
  const work = plan.work;
  const people = await loadPeople(tx, work.flatMap((i) => [i.baId, i.saId, ...i.assigneeIds]));
  const person = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  const count = (ids: Array<string | null>) => {
    const n = new Map<string, number>();
    for (const id of ids) if (id) n.set(id, (n.get(id) ?? 0) + 1);
    return [...n].map(([id, c]) => ({ ...(people.get(id) ?? { id, displayName: '—', initials: '?', avatarUrl: null }), count: c })).sort((a, b) => a.displayName.localeCompare(b.displayName, 'th'));
  };
  const moduleCount = new Map<string, number>();
  for (const i of work) moduleCount.set(i.moduleId ?? NO_MODULE, (moduleCount.get(i.moduleId ?? NO_MODULE) ?? 0) + 1);
  const options = {
    modules: [
      ...moduleRows.map((m) => ({ id: m.id, name: m.name, color: m.color, count: moduleCount.get(m.id) ?? 0 })),
      ...(moduleCount.has(NO_MODULE) ? [{ id: NO_MODULE, name: null, color: null, count: moduleCount.get(NO_MODULE)! }] : []),
    ],
    ba: count(work.map((i) => i.baId)),
    sa: count(work.map((i) => i.saId)),
    dev: count(work.flatMap((i) => i.assigneeIds)),
  };

  const moduleDto = (id: string | null) => {
    const m = id ? moduleOf.get(id) : null;
    return m ? { id: m.id, name: m.name, color: m.color } : null;
  };
  const stateOf = (i: Item): TaskState => {
    if (i.category === 'done') return 'done';
    if (i.planEnd && i.planEnd < now) return 'late';
    // ความคืบหน้าที่ควรเป็นตามวันทำการที่ผ่านไปตั้งแต่ Plan Start
    if (i.planStart && i.planEnd && i.planStart <= now) {
      const total = Math.max(1, cal.workingDaysIn(i.planStart, i.planEnd));
      const passed = cal.workingDaysIn(i.planStart, now);
      if ((passed / total) * 100 - i.progressPct >= RISK_GAP_PCT) return 'at_risk';
    }
    return 'on_track';
  };
  const filtered = work.filter((i) => matches(i, q));

  // ---------- มุมมอง Task: งานระดับล่างสุด (Task ที่ไม่มีลูก / Sub-task) ที่ Plan End อยู่ในช่วง ----------
  const inRange = filtered
    .filter((i) => i.planEnd && i.planEnd >= q.from && i.planEnd <= q.to)
    .sort((a, b) => a.planEnd!.localeCompare(b.planEnd!) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  const tasks = inRange.map((i) => ({
    id: i.id,
    key: i.key,
    title: i.title,
    type: i.type,
    parentKey: i.parentId ? (keyOf.get(i.parentId) ?? null) : null,
    module: moduleDto(i.moduleId),
    phase: i.phaseId ? (phaseOf.get(i.phaseId)?.name ?? null) : null,
    ba: person(i.baId),
    sa: person(i.saId),
    devs: i.assigneeIds.map(person).filter((p): p is Person => !!p),
    estimateMd: i.estimateMd || null,
    planStart: i.planStart,
    planEnd: i.planEnd!,
    progressPct: i.progressPct,
    status: { name: i.statusName, category: i.category },
    state: stateOf(i),
  }));
  const states = tasks.map((t) => t.state);

  // ---------- มุมมอง Plan: กลุ่ม Module › Phase ที่วันจบตามแผน (Plan End สุดท้ายในกลุ่ม) อยู่ในช่วง ----------
  const since = addDays(now, -(VELOCITY_DAYS - 1));
  const sinceDate = new Date(`${since}T00:00:00+07:00`);
  const velocityDays = Math.max(1, cal.workingDaysIn(since, now));
  // อัตราเสร็จจริงของทั้ง Module (ไม่กรองคน) · ตัวกรองคนแค่เลือกว่าจะดูงานส่วนไหนของแผน
  const mdPerDay = new Map<string, number>();
  for (const i of work) {
    if (i.category !== 'done' || !i.completedAt || i.completedAt < sinceDate) continue;
    const k = i.moduleId ?? NO_MODULE;
    mdPerDay.set(k, (mdPerDay.get(k) ?? 0) + i.estimateMd / velocityDays);
  }
  const groups = new Map<string, Item[]>();
  for (const i of filtered) {
    const k = `${i.moduleId ?? NO_MODULE}|${i.phaseId ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const plans = [...groups.values()]
    .map((list) => {
      const first = list[0]!;
      const ends = list.map((i) => i.planEnd).filter((d): d is string => !!d);
      const plannedEnd = ends.length ? ends.reduce((m, e) => (e > m ? e : m)) : null;
      return { list, moduleId: first.moduleId, phaseId: first.phaseId, plannedEnd };
    })
    .filter((g) => g.plannedEnd && g.plannedEnd >= q.from && g.plannedEnd <= q.to)
    .map(({ list, moduleId, phaseId, plannedEnd }) => {
      const totalMd = list.reduce((n, i) => n + i.estimateMd, 0);
      const done = list.filter((i) => i.category === 'done');
      const doneMd = done.reduce((n, i) => n + i.estimateMd, 0);
      const finished = done.length === list.length;
      const progressPct = totalMd > 0 ? Math.round((doneMd / totalMd) * 100) : Math.round((done.length / list.length) * 100);
      // คาดวันจบ: งานที่ยังค้างของ Module (ตามตัวกรอง) ที่ต้องเสร็จก่อนหรือพร้อมกลุ่มนี้ ÷ อัตราเสร็จจริงของ Module
      // นับงานก่อนหน้าด้วยเพราะทีมทำงานตามลำดับแผน Phase หลังจึงไม่ควรเร็วกว่า Phase ก่อน
      let forecastEnd: string | null = null;
      let forecastReason: 'no_estimate' | 'no_velocity' | null = null;
      if (finished) {
        forecastEnd = done.map((i) => i.completedAt).filter((d): d is Date => !!d).map((d) => d.toISOString().slice(0, 10)).sort().at(-1) ?? null;
      } else {
        const ahead = filtered.filter((i) => (i.moduleId ?? null) === (moduleId ?? null) && isOpen(i) && i.planEnd && i.planEnd <= plannedEnd!);
        const remaining = round1(ahead.reduce((n, i) => n + i.estimateMd * (1 - i.progressPct / 100), 0));
        const rate = mdPerDay.get(moduleId ?? NO_MODULE) ?? 0;
        if (remaining <= 0) forecastReason = 'no_estimate';
        else if (rate <= 0) forecastReason = 'no_velocity';
        else forecastEnd = cal.nthWorkingDay(cal.onOrAfter(now), Math.max(1, Math.ceil(remaining / rate)));
      }
      const slipDays = forecastEnd ? slipWorkingDays(plan, plannedEnd!, forecastEnd) : null;
      const status = finished ? 'done' : plannedEnd! < now ? 'late' : slipDays === null ? 'no_forecast' : slipDays <= 0 ? 'on_track' : slipDays <= 3 ? 'at_risk' : 'off_track';
      const m = moduleId ? moduleOf.get(moduleId) : null;
      const p = phaseId ? phaseOf.get(phaseId) : null;
      return {
        module: moduleDto(moduleId),
        phase: p ? { id: p.id, name: p.name } : null,
        sort: [m?.sort ?? Number.MAX_SAFE_INTEGER, p?.sort ?? Number.MAX_SAFE_INTEGER] as const,
        taskCount: list.length,
        doneCount: done.length,
        totalMd: round1(totalMd),
        doneMd: round1(doneMd),
        progressPct,
        plannedEnd: plannedEnd!,
        forecastEnd,
        forecastReason,
        slipDays,
        status,
        tasks: list
          .sort((a, b) => (a.planEnd ?? '9999').localeCompare(b.planEnd ?? '9999') || a.key.localeCompare(b.key, undefined, { numeric: true }))
          .map((i) => ({ key: i.key, title: i.title, devs: i.assigneeIds.map(person).filter((x): x is Person => !!x), estimateMd: i.estimateMd || null, planEnd: i.planEnd, progressPct: i.progressPct, state: stateOf(i) })),
      };
    })
    .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd) || a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
    .map(({ sort: _sort, ...rest }) => rest);

  const planMd = plans.reduce((n, g) => n + g.totalMd, 0);
  const planDoneMd = plans.reduce((n, g) => n + g.doneMd, 0);
  return {
    project: { key: project.key, name: project.name },
    range: { from: q.from, to: q.to },
    asOf: now,
    options,
    summary: {
      taskCount: tasks.length,
      md: round1(inRange.reduce((n, i) => n + i.estimateMd, 0)),
      doneCount: states.filter((x) => x === 'done').length,
      atRiskCount: states.filter((x) => x === 'at_risk').length,
      lateCount: states.filter((x) => x === 'late').length,
    },
    tasks,
    planSummary: {
      groupCount: plans.length,
      md: round1(planMd),
      progressPct: planMd > 0 ? Math.round((planDoneMd / planMd) * 100) : 0,
      slipCount: plans.filter((g) => g.status === 'late' || g.status === 'at_risk' || g.status === 'off_track').length,
    },
    plans,
    velocity: { windowDays: VELOCITY_DAYS },
  };
}
