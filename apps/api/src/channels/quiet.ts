// ช่วงงดส่ง (Quiet hours) · เวลาไทยไม่มี DST จึงคำนวณด้วย offset คงที่ +07:00

const OFFSET_MS = 7 * 3_600_000;

export interface QuietRule {
  /** HH:MM (เวลาไทย) · null ทั้งคู่ = ไม่มีช่วงงดส่งรายวัน */
  start: string | null;
  end: string | null;
  /** งดส่งทั้งวันในวันที่ไม่ใช่วันทำการ */
  holidays: boolean;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** วันที่ (YYYY-MM-DD) และนาทีของวันตามเวลาไทย */
export function localParts(at: Date) {
  const l = new Date(at.getTime() + OFFSET_MS);
  return { date: l.toISOString().slice(0, 10), minutes: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

/** Date จากวันที่ + นาทีของวันตามเวลาไทย */
export function fromLocal(date: string, minutes: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - OFFSET_MS);
}

const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function inWindow(minutes: number, start: number, end: number) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * เวลาที่ส่งได้ถัดไป · null = ส่งได้ทันที
 * งดส่งตามช่วงเวลา → เลื่อนไปสิ้นสุดช่วง · วันหยุด → เลื่อนไปต้นวันถัดไปแล้วตรวจซ้ำ
 */
export function nextSendTime(now: Date, rule: QuietRule, isWorkingDay: (date: string) => boolean): Date | null {
  const start = rule.start ? toMin(rule.start) : null;
  const end = rule.end ? toMin(rule.end) : null;
  let at = now;
  for (let i = 0; i < 40; i++) {
    const { date, minutes } = localParts(at);
    if (rule.holidays && !isWorkingDay(date)) {
      at = fromLocal(nextDate(date), 0);
      continue;
    }
    if (start !== null && end !== null && inWindow(minutes, start, end)) {
      // ช่วงข้ามเที่ยงคืน: ถ้าอยู่ก่อนเที่ยงคืน (>= start) จบพรุ่งนี้
      const endDate = start > end && minutes >= start ? nextDate(date) : date;
      at = fromLocal(endDate, end);
      continue;
    }
    return at.getTime() === now.getTime() ? null : at;
  }
  return at;
}

