import { WorkCalendar, planEndFor } from '../projects/calendar.js';
import { type Cell, type ParsedWorkbook, toIsoDate } from './excel.js';

/**
 * ฟิลด์ปลายทางของการจับคู่คอลัมน์ (หน้า L3 › จับคู่คอลัมน์) · เรียงตามคอลัมน์ของไฟล์รูปแบบใหม่ (ชีต Tasks)
 * alias รวมหัวคอลัมน์ของไฟล์รูปแบบเดิม (ID / No. / Module Task / Dev) เพื่อให้ไฟล์เก่านำเข้าได้ · คอลัมน์ Remark ของไฟล์เดิมเข้าช่อง Remark
 */
export const FIELDS = {
  /** รหัสงาน เช่น DP-12 หรือ 12 · ว่าง = งานใหม่ (ระบบออกเลขให้) */
  key: { label: 'Key (รหัสงาน · ว่าง = งานใหม่)', aliases: ['key', 'issue key', 'id', 'รหัส', 'รหัสงาน'] },
  parentKey: { label: 'Parent Key (Task แม่ของ Sub-task)', aliases: ['parent key', 'parent', 'task แม่'] },
  /** ไฟล์รูปแบบเดิมเท่านั้น: ลำดับแถวในแผน ใช้จับคู่ตอนอัปเดต */
  no: { label: 'No. (ไฟล์รูปแบบเดิม · ใช้จับคู่ตอนอัปเดต)', aliases: ['no', 'no.', 'ลำดับ'] },
  module: { label: 'Module', aliases: ['module'] },
  /** กลุ่มของ Task ใต้ Module (ไม่บังคับ) · Sub-task ใช้กลุ่มของ Task แม่ */
  group: { label: 'Group (กลุ่ม · ไม่บังคับ)', aliases: ['group', 'กลุ่ม'] },
  title: { label: 'ชื่องาน', aliases: ['title', 'ชื่องาน', 'module task', 'task', 'งาน'] },
  status: { label: 'Status', aliases: ['status', 'สถานะ'] },
  priority: { label: 'Priority', aliases: ['priority', 'ความสำคัญ'] },
  ba: { label: 'Business Analyst', aliases: ['business analyst', 'ba'] },
  sa: { label: 'System Analyst', aliases: ['system analyst', 'sa'] },
  devs: { label: 'Developer (หลายคน คั่นด้วย ,)', aliases: ['developer', 'developers', 'dev', 'assignee'] },
  reviewer: { label: 'QA / Reviewer (หลายคน คั่นด้วย ,)', aliases: ['qa / reviewer', 'reviewer', 'reviewers', 'qa', 'tester'] },
  size: { label: 'Size', aliases: ['size'] },
  estimateMd: { label: 'Man-Day (รวมทั้งทีม)', aliases: ['man-day', 'manday', 'md'] },
  planStart: { label: 'Plan Start', aliases: ['plan start'] },
  planEnd: { label: 'Plan End', aliases: ['plan end'] },
  /** QA Due ของโปรเจกต์แยก Dev / QA (ว่าง = Plan End + วันเผื่อ QA) */
  qaEnd: { label: 'QA Due', aliases: ['qa due', 'qa end', 'qa due date'] },
  actualStart: { label: 'Actual Start', aliases: ['actual start'] },
  actualEnd: { label: 'Actual End', aliases: ['actual end'] },
  requirement: { label: 'Requirement (FR / NFR)', aliases: ['requirement', 'requirements', 'fr / nfr', 'fr'] },
  screen: { label: 'Screen', aliases: ['screen', 'screens', 'screen id'] },
  labels: { label: 'Label (หลายค่า คั่นด้วย ,)', aliases: ['label', 'labels'] },
  // รายละเอียด → Description · Remark / หมายเหตุ → Remark ของงาน (ผู้ใช้ตัดสิน 2026-11-09 · เดิมรวมเป็นช่องเดียว)
  description: { label: 'Description (รายละเอียด)', aliases: ['description', 'รายละเอียด'] },
  remark: { label: 'Remark (หมายเหตุ)', aliases: ['remark', 'หมายเหตุ', 'note'] },
} as const;
export type Field = keyof typeof FIELDS;
/** ปลายทางของคอลัมน์: ฟิลด์มาตรฐาน หรือ Custom field ของโปรเจกต์ (`cf:<id>` · เฉพาะโหมดอัปเดตแผน) */
export type MappingTarget = Field | `cf:${string}`;
export type ColumnMapping = Record<string, MappingTarget | null>;
export const isCustomTarget = (t: MappingTarget | null | undefined): t is `cf:${string}` => !!t && t.startsWith('cf:');

const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * จับคู่หัวคอลัมน์อัตโนมัติ · ฟิลด์มาตรฐานก่อน แล้วจึง Custom field ที่ชื่อตรงกัน
 * (ไฟล์ส่งออกเติม " (Custom)" ท้ายชื่อที่ซ้ำคอลัมน์มาตรฐาน จึงรับทั้งสองแบบ)
 */
export function autoMap(headers: string[], customFields: { id: string; name: string }[] = []): ColumnMapping {
  const used = new Set<MappingTarget>();
  const out: ColumnMapping = {};
  for (const h of headers) {
    if (!h) continue;
    const f = (Object.keys(FIELDS) as Field[]).find((k) => !used.has(k) && (FIELDS[k].aliases as readonly string[]).includes(key(h)));
    const c = f ? undefined : customFields.find((x) => !used.has(`cf:${x.id}`) && [key(x.name), `${key(x.name)} (custom)`].includes(key(h)));
    const target: MappingTarget | null = f ?? (c ? `cf:${c.id}` : null);
    out[h] = target;
    if (target) used.add(target);
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

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
const PRIORITY: Record<string, Priority> = { urgent: 'urgent', highest: 'urgent', 'ด่วนมาก': 'urgent', high: 'high', 'สูง': 'high', medium: 'medium', normal: 'medium', 'กลาง': 'medium', low: 'low', 'ต่ำ': 'low' };

/** Key ในไฟล์: "DP-12" / "dp-12" / 12 → { prefix, number } · undefined = รูปแบบไม่ถูกต้อง */
export function parseKey(v: Cell): { prefix: string | null; number: number } | null | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? { prefix: null, number: v } : undefined;
  const m = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/.exec(String(v).trim());
  return m && Number(m[2]) > 0 ? { prefix: m[1]?.toUpperCase() ?? null, number: Number(m[2]) } : undefined;
}

export type Role = 'dev' | 'ba' | 'sa' | 'qa';

export interface PlanRow {
  rowNo: number;
  /**
   * ตัวระบุแถวภายในไฟล์ (ใช้กับ skip / diff)
   * ไฟล์รูปแบบเดิม = No. (เก็บใน excel_row_no) · รูปแบบใหม่ = แถวใน Excel (ไม่เก็บ)
   */
  no: number;
  /** เลขงานจาก Key · null = งานใหม่ ระบบออกเลขให้ */
  number: number | null;
  /** เลขงานของ Task แม่ (Sub-task) */
  parentNumber: number | null;
  module: string;
  phase: string | null;
  title: string;
  screens: string[];
  requirements: string[];
  /** ค่าในคอลัมน์ FR ที่ไม่ใช่รหัส FR / NFR เช่น "SRS" */
  requirementText: string | null;
  ba: string | null;
  sa: string | null;
  /** QA / Reviewer หลายคน (ผู้ใช้ขอ 2026-11-13) */
  reviewers: string[];
  status: string;
  priority: Priority | null;
  devs: string[];
  labels: string[];
  size: Size | null;
  estimateMd: number | null;
  planStart: string | null;
  planEnd: string | null;
  qaEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  description: string | null;
  remark: string | null;
  /** ค่าดิบในคอลัมน์ Custom field (id ของฟิลด์ → เซลล์) · แปลงและตรวจตอนเทียบกับระบบ (update.ts) */
  custom: Record<string, Cell>;
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
  roles: Role[];
  rows: number;
}

export interface PlanCheck {
  rows: PlanRow[];
  findings: Finding[];
  /** no ของแถวที่ต้องแก้ (ข้ามตอนนำเข้า) */
  skip: Set<number>;
  people: Person[];
  /** ไฟล์รูปแบบใหม่ (ไม่มีคอลัมน์ No.) · จับคู่งานด้วย Key */
  keyed: boolean;
  /** ฟิลด์ที่มีคอลัมน์ในไฟล์ · โหมดอัปเดตเทียบเฉพาะฟิลด์เหล่านี้ (ไฟล์ไม่มีคอลัมน์ = ไม่แตะค่าเดิม) */
  mapped: Set<Field>;
  /** id ของ Custom field ที่มีคอลัมน์ในไฟล์ */
  customMapped: string[];
  summary: {
    rows: number;
    modules: number;
    phases: number;
    subtasks: number;
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
  /** โหมดอัปเดต: Key ของโปรเจกต์ · Key ในไฟล์ที่ขึ้นต้นด้วยรหัสอื่นถือว่าผิดโปรเจกต์ */
  projectKey?: string;
  /** โหมดอัปเดต: Task ระดับบนที่มีอยู่ในระบบ (เลขงาน → Module) ให้ Sub-task ในไฟล์อ้างถึงได้ */
  parents?: Map<number, { module: string }>;
}

export function checkPlan(wb: ParsedWorkbook, mapping: ColumnMapping, cal: WorkCalendar, knownPeople: Set<string>, opts: CheckOptions = {}): PlanCheck {
  const known = new Map((opts.statuses ?? []).map((n) => [n.toLowerCase(), n]));
  const resolveStatus = (raw: unknown) => known.get(String(raw ?? '').trim().toLowerCase()) ?? STATUS[String(raw ?? '').trim().toLowerCase()];
  const idx = {} as Record<Field, number>;
  const cfIdx: [string, number][] = [];
  wb.table.headers.forEach((h, i) => {
    const f = mapping[h];
    if (isCustomTarget(f)) cfIdx.push([f.slice(3), i]);
    else if (f) idx[f] = i;
  });
  const mapped = new Set(Object.keys(idx) as Field[]);
  // ไฟล์รูปแบบเดิมมีคอลัมน์ No. เป็นตัวจับคู่ · รูปแบบใหม่ใช้ Key
  const keyed = idx.no === undefined;
  const get = (cells: Cell[], f: Field) => (idx[f] === undefined ? null : cells[idx[f]]);
  const text = (v: Cell) => (v === null ? null : String(v).trim() || null);
  const person = (v: Cell) => {
    const x = text(v);
    return x && x !== '-' && x !== '—' ? x : null;
  };

  const rows: PlanRow[] = [];
  const findings: Finding[] = [];
  const skip = new Set<number>();
  const seen = new Set<number>();
  const seenNumber = new Set<number>();
  const people = new Map<string, Person>();
  const addPerson = (name: string, role: Role) => {
    const k = personKey(name);
    const p = people.get(k) ?? { name, roles: [], rows: 0 };
    if (!p.roles.includes(role)) p.roles.push(role);
    p.rows++;
    people.set(k, p);
  };
  const findingOf = (r: PlanRow) => ({ no: keyed ? null : r.no, rowNo: r.rowNo, module: r.module || null, title: r.title || null });

  for (const { rowNo, cells } of wb.table.rows) {
    const module = text(get(cells, 'module'));
    const title = text(get(cells, 'title'));
    const rawNo = get(cells, 'no');
    const legacyNo = typeof rawNo === 'number' ? rawNo : Number(rawNo);
    const no = keyed ? rowNo : legacyNo;
    const base = { rowNo, no: !keyed && Number.isInteger(legacyNo) ? legacyNo : null, module, title };
    const err = (problem: string, fix: string) => findings.push({ level: 'err', ...base, problem, fix });
    const warn = (problem: string, fix: string) => findings.push({ level: 'warn', ...base, problem, fix });

    if (!keyed) {
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
    }
    // เลขงาน: Key ในไฟล์ · ไฟล์รูปแบบเดิมที่ไม่มีคอลัมน์ ID ใช้ No.
    let number: number | null = keyed ? null : no;
    if (idx.key !== undefined) {
      const k = parseKey(get(cells, 'key'));
      if (k === undefined || (k === null && !keyed)) {
        err(k === undefined ? `Key "${get(cells, 'key')}" รูปแบบไม่ถูกต้อง` : 'ID ว่างหรือไม่ใช่ตัวเลข', 'ใช้รูปแบบ DP-12 หรือเว้นว่างสำหรับงานใหม่');
        skip.add(no);
        continue;
      }
      if (k?.prefix && opts.projectKey && k.prefix !== opts.projectKey.toUpperCase()) {
        err(`Key ${k.prefix}-${k.number} ไม่ใช่งานของโปรเจกต์ ${opts.projectKey}`, 'แก้ Key หรือเว้นว่างเพื่อสร้างเป็นงานใหม่');
        skip.add(no);
        continue;
      }
      number = k?.number ?? null;
    }
    if (number !== null && seenNumber.has(number)) {
      err(`${keyed ? 'Key' : 'ID'} ${number} ซ้ำ`, 'แก้ไขใน Excel');
      skip.add(no);
      continue;
    }
    if (number !== null) seenNumber.add(number);
    const parent = parseKey(get(cells, 'parentKey'));

    const dates = Object.fromEntries(
      (['planStart', 'planEnd', 'qaEnd', 'actualStart', 'actualEnd'] as const).map((f) => [f, toIsoDate(get(cells, f))]),
    ) as Record<'planStart' | 'planEnd' | 'qaEnd' | 'actualStart' | 'actualEnd', string | null | undefined>;
    const mdRaw = get(cells, 'estimateMd');
    const md = mdRaw === null ? null : Number(mdRaw);
    const sizeRaw = get(cells, 'size');
    const size = sizeRaw && (SIZES as readonly string[]).includes(String(sizeRaw).toUpperCase()) ? (String(sizeRaw).toUpperCase() as Size) : null;
    const statusRaw = get(cells, 'status');
    const priorityRaw = text(get(cells, 'priority'));
    const reqs = list(get(cells, 'requirement'));

    const row: PlanRow = {
      rowNo,
      no,
      number,
      parentNumber: parent?.number ?? null,
      module: module ?? '',
      // กลุ่มจากคอลัมน์ Group (ไม่บังคับ) · คอลัมน์ Sprint ของไฟล์แผนเดิมไม่ถูกนำเข้า
      phase: text(get(cells, 'group')),
      title: title ?? '',
      screens: list(get(cells, 'screen')).filter((x) => /^SCR-/i.test(x)),
      requirements: reqs.filter((x) => /^N?FR-/i.test(x)).map((x) => x.toUpperCase()),
      requirementText: reqs.filter((x) => !/^N?FR-/i.test(x)).join(', ') || null,
      ba: person(get(cells, 'ba')),
      sa: person(get(cells, 'sa')),
      reviewers: [...new Set(list(get(cells, 'reviewer')).filter((x) => x !== '-' && x !== '—'))],
      status: resolveStatus(statusRaw) ?? 'To do',
      priority: priorityRaw ? (PRIORITY[priorityRaw.toLowerCase()] ?? null) : null,
      devs: list(get(cells, 'devs')),
      labels: [...new Set(String(get(cells, 'labels') ?? '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean))],
      size: size ?? (!opts.noDerivedSize && md && md > 0 ? sizeFromMd(md) : null),
      estimateMd: md !== null && Number.isFinite(md) && md > 0 ? md : null,
      planStart: dates.planStart ?? null,
      planEnd: dates.planEnd ?? null,
      qaEnd: dates.qaEnd ?? null,
      actualStart: dates.actualStart ?? null,
      actualEnd: dates.actualEnd ?? null,
      description: text(get(cells, 'description')),
      remark: text(get(cells, 'remark')),
      custom: Object.fromEntries(cfIdx.map(([id, i]) => [id, cells[i] ?? null])),
    };

    // ต้องแก้ (ข้ามตอนนำเข้า)
    const blocking: [string, string][] = [];
    if (!row.title) blocking.push(['ไม่มีชื่องาน', 'แก้ไขใน Excel']);
    // Sub-task ใช้ Module ของ Task แม่ (ตรวจหลังอ่านครบทุกแถว)
    if (parent === undefined) blocking.push([`Parent Key "${get(cells, 'parentKey')}" รูปแบบไม่ถูกต้อง`, 'ใช้รูปแบบ DP-12']);
    else if (parent && number !== null && parent.number === number) blocking.push(['Parent Key ชี้มาที่ตัวเอง', 'แก้ไขใน Excel']);
    if (!row.module && !parent) blocking.push(['ไม่มี Module', 'แก้ไขใน Excel']);
    for (const f of ['planStart', 'planEnd', 'qaEnd', 'actualStart', 'actualEnd'] as const) {
      if (dates[f] === undefined) blocking.push([`${FIELDS[f].label} รูปแบบวันที่ไม่ถูกต้อง`, 'แก้ไขใน Excel']);
    }
    if (mdRaw !== null && row.estimateMd === null) blocking.push(['Man-Day ไม่ใช่ตัวเลขที่มากกว่า 0', 'แก้ไขใน Excel']);
    const scheduled = !!(row.planStart || row.planEnd);
    // BA บังคับเฉพาะ Task ที่ลงแผนแล้วในไฟล์รูปแบบเดิม (หน้า L3) · รูปแบบใหม่และ Sub-task เป็นแค่คำเตือน
    const baRequired = !opts.baOptional && !keyed;
    if (scheduled && !row.ba && baRequired && !parent) blocking.push(['ไม่มี BA', 'ระบุ BA ใน Excel']);
    if (blocking.length) {
      blocking.forEach(([p, f]) => err(p, f));
      skip.add(no);
      rows.push(row);
      continue;
    }

    // เตือน (นำเข้าได้)
    if (scheduled && !row.ba && !baRequired && !parent && mapped.has('ba')) warn('ไม่มี BA', 'ยังไม่ระบุ BA');
    if (!scheduled) warn('ไม่มี Plan Start / End', 'นำเข้าเป็น Backlog ยังไม่ลงแผน');
    if (statusRaw === null) warn('ไม่มีค่า Status', 'ใช้ To do');
    else if (!resolveStatus(statusRaw)) warn(`Status "${statusRaw}" ไม่รู้จัก`, 'ใช้ To do');
    if (priorityRaw && !row.priority) warn(`Priority "${priorityRaw}" ไม่รู้จัก`, 'ใช้ Medium');
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
    rows.push(row);
  }

  // Sub-task: Task แม่ต้องอยู่ในไฟล์ (หรือในระบบ ตอนอัปเดต) และเป็นงานระดับ Task · Module ตามแม่
  const byNumber = new Map(rows.filter((r) => r.number !== null).map((r) => [r.number!, r]));
  for (const r of rows) {
    if (r.parentNumber === null || skip.has(r.no)) continue;
    const err = (problem: string, fix: string) => {
      findings.push({ level: 'err', ...findingOf(r), problem, fix });
      skip.add(r.no);
    };
    const inFile = byNumber.get(r.parentNumber);
    const inSystem = opts.parents?.get(r.parentNumber);
    if (inFile && inFile.parentNumber !== null) {
      err(`Task แม่ ${r.parentNumber} เป็น Sub-task อยู่แล้ว`, 'Sub-task ต้องอยู่ใต้งานระดับ Task เท่านั้น');
      continue;
    }
    if (inFile && skip.has(inFile.no)) {
      err(`Task แม่ ${r.parentNumber} มีข้อผิดพลาด`, 'แก้แถวของ Task แม่ก่อน');
      continue;
    }
    const parentModule = inFile?.module ?? inSystem?.module;
    if (!parentModule) {
      err(`ไม่พบ Task แม่ ${r.parentNumber}`, 'ใส่ Key ของ Task ที่อยู่ในไฟล์หรือในโปรเจกต์');
      continue;
    }
    // Sub-task อยู่กลุ่มเดียวกับ Task แม่เสมอ
    if (inFile) r.phase = inFile.phase;
    if (r.module && r.module !== parentModule) findings.push({ level: 'warn', ...findingOf(r), problem: `Module "${r.module}" ไม่ตรงกับ Task แม่`, fix: `ใช้ Module ของ Task แม่ (${parentModule})` });
    r.module = parentModule;
    if (inFile && ((r.planStart && inFile.planStart && r.planStart < inFile.planStart) || (r.planEnd && inFile.planEnd && r.planEnd > inFile.planEnd))) {
      findings.push({ level: 'warn', ...findingOf(r), problem: `วันที่อยู่นอกช่วงของ Task แม่ ${r.parentNumber}`, fix: 'นำเข้าตามไฟล์ · ขยายช่วงของ Task แม่ได้ภายหลัง' });
    }
  }

  for (const r of rows) {
    if (skip.has(r.no)) continue;
    r.devs.forEach((d) => addPerson(d, 'dev'));
    if (r.ba) addPerson(r.ba, 'ba');
    if (r.sa) addPerson(r.sa, 'sa');
    r.reviewers.forEach((q) => addPerson(q, 'qa'));
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
  const backlog = ok.filter((r) => !r.planStart && !r.planEnd).length;
  const all = [...people.values()];
  return {
    rows,
    findings,
    skip,
    people: all,
    keyed,
    mapped,
    customMapped: cfIdx.map(([id]) => id),
    summary: {
      rows: rows.length,
      modules: modules.size,
      phases: new Set(ok.filter((r) => r.phase && r.parentNumber === null).map((r) => `${r.module}\u0000${r.phase}`)).size,
      subtasks: ok.filter((r) => r.parentNumber !== null).length,
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
