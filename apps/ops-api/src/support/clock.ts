// เวลาทำการของทีม Support (O22) · เวลาไทย (UTC+7 ไม่มีเวลาออมแสง) · ไม่ผูกฐานข้อมูลเพื่อทดสอบง่าย
const DAY = 86_400_000;
const OFF = 7 * 3_600_000;
const MIN = 60_000;

/** ช่วงเวลาทำการรายวัน · index 0 = จันทร์ … 6 = อาทิตย์ */
export interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
/** ระยะ SLA · h = ชั่วโมงทำการ · d = วันทำการ (ครบวันทำการที่ N เวลาเดิม) */
export interface Dur {
  n: number;
  unit: 'h' | 'd';
}

export const DEFAULT_HOURS: DayHours[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ open: i < 5, from: '09:00', to: '18:00' }));
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export class BusinessClock {
  constructor(
    private readonly hours: DayHours[] = DEFAULT_HOURS,
    /** วันหยุด 'YYYY-MM-DD' (วันที่ไทย) */
    private readonly holidays: ReadonlySet<string> = new Set(),
  ) {}

  /** เที่ยงคืนเวลาไทยของวันที่ t อยู่ (เป็นเวลา UTC) */
  private dayStart(t: number) {
    return Math.floor((t + OFF) / DAY) * DAY - OFF;
  }
  /** ช่วงทำการของวันที่เริ่ม `start` เป็นนาทีนับจากเที่ยงคืน · null = วันปิด/วันหยุด */
  private window(start: number): [number, number] | null {
    const local = new Date(start + OFF);
    const h = this.hours[(local.getUTCDay() + 6) % 7];
    if (!h?.open || this.holidays.has(local.toISOString().slice(0, 10))) return null;
    const w: [number, number] = [mins(h.from), mins(h.to)];
    return w[1] > w[0] ? w : null;
  }

  isOpen(at: Date) {
    const d = this.dayStart(at.getTime());
    const w = this.window(d);
    const m = (at.getTime() - d) / MIN;
    return !!w && m >= w[0] && m < w[1];
  }

  /** เวลาเปิดทำการถัดไป (หรือเวลาเดิมถ้าเปิดอยู่) */
  nextOpen(at: Date) {
    let d = this.dayStart(at.getTime());
    for (let i = 0; i < 400; i++, d += DAY) {
      const w = this.window(d);
      if (!w) continue;
      const t = Math.max(at.getTime(), d + w[0] * MIN);
      if (t < d + w[1] * MIN) return new Date(t);
    }
    return at;
  }

  /** บวกชั่วโมงทำการ */
  addHours(start: Date, hours: number) {
    let left = Math.round(hours * 60);
    let t = start.getTime();
    for (let i = 0; i < 800; i++) {
      const d = this.dayStart(t);
      const w = this.window(d);
      const cur = (t - d) / MIN;
      if (!w || cur >= w[1]) {
        t = d + DAY;
        continue;
      }
      const from = Math.max(cur, w[0]);
      const avail = w[1] - from;
      if (left <= avail) return new Date(d + (from + left) * MIN);
      left -= avail;
      t = d + DAY;
    }
    return new Date(t);
  }

  /** ครบ N วันทำการ: วันทำการที่ N ถัดจากวันที่เริ่มนับ ณ เวลาเดิม (ขยับเข้าช่วงทำการของวันนั้น) */
  addDays(start: Date, n: number) {
    const s = this.nextOpen(start);
    const clock = (s.getTime() - this.dayStart(s.getTime())) / MIN;
    let d = this.dayStart(s.getTime());
    for (let left = n, i = 0; left > 0 && i < 800; i++) {
      d += DAY;
      if (this.window(d)) left--;
    }
    const w = this.window(d) ?? [clock, clock];
    return new Date(d + Math.min(Math.max(clock, w[0]), w[1]) * MIN);
  }

  add(start: Date, dur: Dur) {
    return dur.unit === 'd' ? this.addDays(start, dur.n) : this.addHours(start, dur.n);
  }
}

/** ความสำคัญ "ด่วน" นับ 24 ชม. ทุกวัน (ไม่ใช้เวลาทำการ) · 1 วัน = 24 ชม. */
export const wallClock = (start: Date, dur: Dur) => new Date(start.getTime() + dur.n * (dur.unit === 'd' ? 24 : 1) * 3_600_000);
export const durHours = (dur: Dur) => dur.n * (dur.unit === 'd' ? 24 : 1);
