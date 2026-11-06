import { WorkCalendar, planEndFor } from '../projects/calendar.js';
import { type Cell, type ParsedWorkbook, toIsoDate } from './excel.js';

/** ฟิลด์ปลายทางของการจับคู่คอลัมน์ (หน้า L3 › จับคู่คอลัมน์) */
export const FIELDS = {
  /** เลขงานในระบบ (DP-39 = ID 39) · ถ้าไม่มีคอลัมน์นี้ใช้ No. แทน */
  id: { label: 'รหัสงาน (ID) → เลขงาน', aliases: ['id', 'รหัส'] },
  no: { label: 'ลำดับ (ใช้จับคู่ตอนอัปเดต)', aliases: ['no', 'no.', 'ลำดับ'] },
  module: { label: 'Module', aliases: ['module'] },
  phase: { label: 'กลุ่มงาน (Phase) ใน Module', aliases: ['sprint', 'phase', 'กลุ่มงาน'] },
  title: { label: 'ชื่องาน', aliases: ['module task', 'task', 'ชื่องาน', 'งาน'] },
  screen: { label: 'Screen ID', aliases: ['screen', 'screen id'] },
  requirement: { label: 'Requirement (FR / NFR)', aliases: ['fr / nfr', 'fr', 'requirement'] },
  ba: { label: 'BA', aliases: ['ba'] },
  status: { label: 'Status', aliases: ['status', 'สถานะ'] },
  devs: { label: 'Dev (หลายคน คั่นด้วย ,)', aliases: ['dev', 'developer', 'assignee'] },
  size: { label: 'Size', aliases: ['size'] },
  estimateMd: { label: 'Man-Day (รวมทั้งทีม)', aliases: ['man-day', 'manday', 'md'] },
  planStart: { label: 'Plan Start', aliases: ['plan start'] },
  planEnd: { label: 'Plan End', aliases: ['plan end'] },
  actualStart: { label: 'Actual Start', aliases: ['actual start'] },
  actualEnd: { label: 'Actual End', aliases: ['actual end'] },
  remark: { label: 'หมายเหตุ', aliases: ['remark', 'หมายเหตุ', 'note'] },
} as const;
export type Field = keyof typeof FIELDS;
export type ColumnMapping = Record<string, Field | null>;

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function autoMap(headers: string[]): ColumnMapping {
  const used = new Set<Field>();
  const out: ColumnMapping = {};
  for (const h of headers) {
    if (!h) continue;
    const f = (Object.keys(FIELDS) as Field[]).find((k) => !used.has(k) && (FIELDS[k].aliases as readonly string[]).includes(key(h)));
    out[h] = f ?? null;
    if (f) used.add(f);
  }
  return out;
}

const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
type Size = (typeof SIZES)[number];
/** Size จาก Man-Day ตามสูตรในไฟล์แผน: ≤1 XS · ≤3 S · ≤5 M · ≤8 L · มากกว่านั้น XL */
export const sizeFromMd = (md: number): Size => (md <= 1 ? 'XS' : md <= 3 ? 'S' : md <= 5 ? 'M' : md <= 8 ? 'L' : 'XL');

const STATUS: Record<string, string> = {
  'not start': 'To do',
  'not started': 'To do',
  'to do': 'To do',
  todo: 'To do',
  'in progress': 'In progress',
  doing: 'In progress',
  review: 'Review',
  done: 'Done',
  completed: 'Done',
};

/** ชื่อคนเทียบกันแบบไม่สนตัวพิมพ์และ ’ กับ ' */
export const personKey = (n: string) => n.trim().toLowerCase().replace(/[’‘`]/g, "'");
const list = (v: Cell) =>
  v === null
    ? []
    : String(v)
        .split(/[,\n/]+/)
        .map((x) => x.trim())
        .filter((x) => x && x !== '-' && x !== '—');

export interface PlanRow {
  rowNo: number;
  no: number;
  /** เลขงาน = ID ถ้ามี ไม่อย่างนั้น = No. */
  number: number;
  module: string;
  phase: string | null;
  title: string;
  screens: string[];
  requirements: string[];
  /** ค่าในคอลัมน์ FR ที่ไม่ใช่รหัส FR / NFR เช่น "SRS" */
  requirementText: string | null;
  ba: string | null;
  status: string;
  devs: string[];
  size: Size | null;
  estimateMd: number | null;
  planStart: string | null;
  planEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  remark: string | null;
}

export type Level = 'err' | 'warn';
export interface Finding {
  level: Level;
  no: number | null;
  rowNo: number;
  module: string | null;
  title: string | null;
  problem: string;
  fix: string;
}

export interface Person {
  name: string;
  roles: ('dev' | 'ba')[];
  rows: number;
}

export interface PlanCheck {
  rows: PlanRow[];
  findings: Finding[];
  /** No. ของแถวที่ต้องแก้ (ข้ามตอนนำเข้า) */
  skip: Set<number>;
  people: Person[];
  summary: {
    rows: number;
    modules: number;
    phases: number;
    manDay: number;
    devs: number;
    bas: number;
    planFrom: string | null;
    planTo: string | null;
    ready: number;
    backlog: number;
    skipped: number;
  };
}

/** แปลงแถวตามการจับคู่คอลัมน์ แล้วตรวจตามกติกาของหน้า L3 · ตรวจสอบข้อมูล */
export interface CheckOptions {
  /** โหมดอัปเดต: ถ้าไฟล์ระบุ Plan End ให้ใช้ค่าในไฟล์ (เตือนถ้าไม่ตรงกับที่คำนวณ) แทนการคำนวณทับ */
  keepPlanEnd?: boolean;
  /** โหมดอัปเดต: งานที่สร้างในระบบอาจไม่มี BA จึงเป็นแค่คำเตือน */
  baOptional?: boolean;
  /** โหมดอัปเดต: Size ว่างในไฟล์ = ว่าง (ไม่คำนวณจาก Man-Day) เพื่อให้ตรงกับงานที่ไม่ได้ตั้ง Size */
  noDerivedSize?: boolean;
  /** ชื่อสถานะจริงใน Workflow ของโปรเจกต์ (โหมดอัปเดต) · ตรงชื่อก่อนใช้ตารางแปลงมาตรฐาน */
  statuses?: string[];
}

export function checkPlan(wb: ParsedWorkbook, mapping: ColumnMapping, cal: WorkCalendar, knownPeople: Set<string>, opts: CheckOptions = {}): PlanCheck {
  const known = new Map((opts.statuses ?? []).map((n) => [n.toLowerCase(), n]));
  const resolveStatus = (raw: unknown) => known.get(String(raw ?? '').trim().toLowerCase()) ?? STATUS[String(raw ?? '').trim().toLowerCase()];
  const idx = {} as Record<Field, number>;
  wb.table.headers.forEach((h, i) => {
    const f = mapping[h];
    if (f) idx[f] = i;
  });
  const get = (cells: Cell[], f: Field) => (idx[f] === undefined ? null : cells[idx[f]]);

  const rows: PlanRow[] = [];
  const findings: Finding[] = [];
  const skip = new Set<number>();
  const seen = new Set<number>();
  const seenNumber = new Set<number>();
  const people = new Map<string, Person>();
  const addPerson = (name: string, role: 'dev' | 'ba') => {
    const k = personKey(name);
    const p = people.get(k) ?? { name, roles: [], rows: 0 };
    if (!p.roles.includes(role)) p.roles.push(role);
    p.rows++;
    people.set(k, p);
  };

  for (const { rowNo, cells } of wb.table.rows) {
    const rawNo = get(cells, 'no');
    const no = typeof rawNo === 'number' ? rawNo : Number(rawNo);
    const module = get(cells, 'module');
    const title = get(cells, 'title');
    const base = { rowNo, no: Number.isInteger(no) ? no : null, module: module === null ? null : String(module), title: title === null ? null : String(title) };
    const err = (problem: string, fix: string) => findings.push({ level: 'err', ...base, problem, fix });
    const warn = (problem: string, fix: string) => findings.push({ level: 'warn', ...base, problem, fix });

    if (!Number.isInteger(no) || no < 1) {
      err('No. ว่างหรือไม่ใช่ตัวเลข', 'แก้ไขใน Excel');
      continue;
    }
    if (seen.has(no)) {
      err(`No. ${no} ซ้ำ`, 'แก้ไขใน Excel');
      skip.add(no);
      continue;
    }
    seen.add(no);
    let number = no;
    if (idx.id !== undefined) {
      const rawId = get(cells, 'id');
      const id = typeof rawId === 'number' ? rawId : Number(rawId);
      if (!Number.isInteger(id) || id < 1) {
        err('ID ว่างหรือไม่ใช่ตัวเลข', 'แก้ไขใน Excel');
        skip.add(no);
        continue;
      }
      number = id;
    }
    if (seenNumber.has(number)) {
      err(`ID ${number} ซ้ำ`, 'แก้ไขใน Excel');
      skip.add(no);
      continue;
    }
    seenNumber.add(number);

    const dates = Object.fromEntries(
      (['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const).map((f) => [f, toIsoDate(get(cells, f))]),
    ) as Record<'planStart' | 'planEnd' | 'actualStart' | 'actualEnd', string | null | undefined>;
    const mdRaw = get(cells, 'estimateMd');
    const md = mdRaw === null ? null : Number(mdRaw);
    const sizeRaw = get(cells, 'size');
    const size = sizeRaw && (SIZES as readonly string[]).includes(String(sizeRaw).toUpperCase()) ? (String(sizeRaw).toUpperCase() as Size) : null;
    const statusRaw = get(cells, 'status');
    const reqs = list(get(cells, 'requirement'));
    const ba = get(cells, 'ba') === null ? null : String(get(cells, 'ba')).trim();
    const devs = list(get(cells, 'devs'));

    const row: PlanRow = {
      rowNo,
      no,
      number,
      module: base.module ?? '',
      phase: get(cells, 'phase') === null ? null : String(get(cells, 'phase')),
      title: base.title ?? '',
      screens: list(get(cells, 'screen')).filter((x) => /^SCR-/i.test(x)),
      requirements: reqs.filter((x) => /^N?FR-/i.test(x)).map((x) => x.toUpperCase()),
      requirementText: reqs.filter((x) => !/^N?FR-/i.test(x)).join(', ') || null,
      ba: ba && ba !== '-' ? ba : null,
      status: resolveStatus(statusRaw) ?? 'To do',
      devs,
      size: size ?? (!opts.noDerivedSize && md && md > 0 ? sizeFromMd(md) : null),
      estimateMd: md !== null && Number.isFinite(md) && md > 0 ? md : null,
      planStart: dates.planStart ?? null,
      planEnd: dates.planEnd ?? null,
      actualStart: dates.actualStart ?? null,
      actualEnd: dates.actualEnd ?? null,
      remark: get(cells, 'remark') === null ? null : String(get(cells, 'remark')),
    };

    // ต้องแก้ (ข้ามตอนนำเข้า)
    const blocking: [string, string][] = [];
    if (!row.title) blocking.push(['ไม่มีชื่องาน', 'แก้ไขใน Excel']);
    if (!row.module) blocking.push(['ไม่มี Module', 'แก้ไขใน Excel']);
    for (const f of ['planStart', 'planEnd', 'actualStart', 'actualEnd'] as const) {
      if (dates[f] === undefined) blocking.push([`${FIELDS[f].label} รูปแบบวันที่ไม่ถูกต้อง`, 'แก้ไขใน Excel']);
    }
    if (mdRaw !== null && row.estimateMd === null) blocking.push(['Man-Day ไม่ใช่ตัวเลขที่มากกว่า 0', 'แก้ไขใน Excel']);
    const scheduled = !!(row.planStart || row.planEnd);
    if (scheduled && !row.ba && !opts.baOptional) blocking.push(['ไม่มี BA', 'ระบุ BA ใน Excel']);
    if (blocking.length) {
      blocking.forEach(([p, f]) => err(p, f));
      skip.add(no);
      rows.push(row);
      continue;
    }

    // เตือน (นำเข้าได้)
    if (scheduled && !row.ba && opts.baOptional) warn('ไม่มี BA', 'ยังไม่ระบุ BA');
    if (!scheduled) warn('ไม่มี Plan Start / End', 'นำเข้าเป็น Backlog ยังไม่ลงแผน');
    if (statusRaw === null) warn('ไม่มีค่า Status', 'ใช้ To do');
    else if (!resolveStatus(statusRaw)) warn(`Status "${statusRaw}" ไม่รู้จัก`, 'ใช้ To do');
    if (row.planStart && !cal.isWorkingDay(row.planStart)) {
      const moved = cal.onOrAfter(row.planStart);
      warn(`Plan Start ${row.planStart} ตรงวันหยุด`, `เริ่มนับวันทำงานถัดไป (${moved})`);
      row.planStart = moved;
    }
    if (row.planStart && row.estimateMd) {
      const computed = planEndFor(cal, row.planStart, row.estimateMd);
      if (row.planEnd && row.planEnd !== computed) warn(`Plan End ในไฟล์ ${row.planEnd} ไม่ตรงกับที่คำนวณ ${computed}`, opts.keepPlanEnd ? 'ใช้วันที่ในไฟล์' : 'ใช้วันที่ระบบคำนวณ');
      if (!(opts.keepPlanEnd && row.planEnd)) row.planEnd = computed;
    }
    if (row.planStart && row.planEnd && row.planEnd < row.planStart) {
      err('Plan End ก่อน Plan Start', 'แก้ไขใน Excel');
      skip.add(no);
    }
    row.devs.forEach((d) => addPerson(d, 'dev'));
    if (row.ba) addPerson(row.ba, 'ba');
    rows.push(row);
  }

  // คอลัมน์ Sprint (กลุ่มงาน) ที่ใส่ชื่องานแทน: Module ที่กลุ่มอื่นเป็น "Sprint N : …" แต่แถวนี้ไม่ใช่
  const SPRINT_LIKE = /^(sprint|phase|provider)\s*\d*\s*:/i;
  const byModule = new Map<string, PlanRow[]>();
  rows.filter((r) => !skip.has(r.no) && r.phase).forEach((r) => byModule.set(r.module, [...(byModule.get(r.module) ?? []), r]));
  for (const list of byModule.values()) {
    const like = list.filter((r) => SPRINT_LIKE.test(r.phase!)).length;
    if (like < list.length / 2) continue;
    for (const r of list.filter((x) => !SPRINT_LIKE.test(x.phase!))) {
      findings.push({ level: 'warn', no: r.no, rowNo: r.rowNo, module: r.module, title: r.title, problem: `คอลัมน์ Sprint เป็น "${r.phase!.slice(0, 40)}" ดูไม่ใช่ชื่อกลุ่มงาน`, fix: 'นำเข้าเป็นกลุ่มงานตามค่าเดิม · แก้ชื่อได้ภายหลัง' });
    }
  }

  // คนที่ยังไม่อยู่ในรายชื่อสมาชิก (เตือนครั้งเดียวต่อคน)
  for (const p of people.values()) {
    if (!knownPeople.has(personKey(p.name))) {
      findings.push({ level: 'warn', no: null, rowNo: 0, module: null, title: null, problem: `ไม่พบ "${p.name}" ในรายชื่อสมาชิก (${p.rows} แถว)`, fix: 'จับคู่กับสมาชิก / เชิญด้วยอีเมล / ไม่ระบุ' });
    }
  }

  const ok = rows.filter((r) => !skip.has(r.no));
  const starts = ok.map((r) => r.planStart).filter((x): x is string => !!x).sort();
  const ends = ok.map((r) => r.planEnd).filter((x): x is string => !!x).sort();
  const modules = new Set(ok.map((r) => r.module));
  const phases = new Set(ok.filter((r) => r.phase).map((r) => `${r.module}\u0000${r.phase}`));
  const backlog = ok.filter((r) => !r.planStart && !r.planEnd).length;
  const all = [...people.values()];
  return {
    rows,
    findings,
    skip,
    people: all,
    summary: {
      rows: rows.length,
      modules: modules.size,
      phases: phases.size,
      // ยอดรวมของทั้งไฟล์ (รวมแถวที่ต้องแก้) ตามหน้า L3
      manDay: rows.reduce((n, r) => n + (r.estimateMd ?? 0), 0),
      devs: all.filter((p) => p.roles.includes('dev')).length,
      bas: all.filter((p) => p.roles.includes('ba')).length,
      planFrom: starts[0] ?? null,
      planTo: ends[ends.length - 1] ?? null,
      ready: ok.length - backlog,
      backlog,
      skipped: skip.size,
    },
  };
}
