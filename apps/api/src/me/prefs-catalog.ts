// ตารางการแจ้งเตือน "เหตุการณ์ × ช่องทาง" ของหน้า Profile (Canvas I) · เป็นข้อมูลชุดเดียวที่ใช้ทั้งแสดงและตรวจ PUT
import { EMAIL_DEFAULT_ON } from '../channels/dispatcher.js';
import { IN_APP_LOCKED } from '../notifications/rules.js';

export const PREF_CHANNELS = ['in_app', 'email', 'line'] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];

export interface PrefRow {
  eventType: string;
  group: 'assigned' | 'activity' | 'schedule' | 'project';
  label: string;
  hint?: string;
  /** ค่าเริ่มต้นของ LINE ตาม Canvas I (In-app ปิดเฉพาะ digest · Email ดู EMAIL_DEFAULT_ON) */
  line: boolean;
}

export const PREF_ROWS: PrefRow[] = [
  { eventType: 'issue.assigned', group: 'assigned', label: 'ถูกมอบหมายงาน หรือถูกถอดออกจากงาน', line: true },
  { eventType: 'issue.review_requested', group: 'assigned', label: 'ถูกขอให้ Review หรือเป็น Tester', hint: 'รวมถึง PR ที่ระบุให้ฉัน Review', line: true },
  { eventType: 'issue.mentioned', group: 'activity', label: 'มีคน @mention ฉัน', line: true },
  { eventType: 'issue.commented', group: 'activity', label: 'คอมเมนต์ใหม่ในงานที่ฉันเป็น Assignee / Watcher', line: false },
  { eventType: 'issue.updated', group: 'activity', label: 'Due / Priority ของงานที่เกี่ยวข้องเปลี่ยน', line: false },
  { eventType: 'issue.status_changed', group: 'activity', label: 'สถานะของงานที่เกี่ยวข้อง หรือ Sub-task ใต้ Task ของฉันเปลี่ยน', line: false },
  { eventType: 'test_run.failed', group: 'activity', label: 'ผลทดสอบไม่ผ่านในงานของฉัน', hint: 'ผลทดสอบไม่ผ่านจะแจ้งทุกช่องทางที่เลือก', line: true },
  { eventType: 'bug.created', group: 'activity', label: 'Bug ใหม่ที่ฉันเกี่ยวข้อง', line: false },
  { eventType: 'bug.reopened', group: 'activity', label: 'Bug ถูก Reopen', line: false },
  { eventType: 'due_request.created', group: 'activity', label: 'คำขอเลื่อน Due ที่รอฉันอนุมัติ', hint: 'สำหรับ PM / Admin ของโปรเจกต์', line: true },
  { eventType: 'due_request.decided', group: 'activity', label: 'ผลการขอเลื่อน Due ของฉัน', line: false },
  { eventType: 'issue.due_soon', group: 'schedule', label: 'งานใกล้ครบกำหนด', hint: 'ตามที่ตั้งด้านล่าง', line: true },
  { eventType: 'issue.overdue', group: 'schedule', label: 'งานเลยกำหนด', line: true },
  { eventType: 'member.joined', group: 'project', label: 'ถูกเพิ่มเข้าโปรเจกต์ หรือเปลี่ยนสิทธิ์', line: false },
  { eventType: 'project.health_changed', group: 'project', label: 'Health ของโปรเจกต์เปลี่ยน (At risk / Off track)', hint: 'สำหรับ PM', line: true },
  { eventType: 'sprint.started', group: 'project', label: 'Sprint เริ่ม', line: false },
  { eventType: 'sprint.completed', group: 'project', label: 'Sprint จบ', line: false },
  { eventType: 'plan.changed', group: 'project', label: 'แผนถูกแก้หลังตั้ง Baseline', hint: 'สำหรับ PM', line: false },
  { eventType: 'digest.daily', group: 'schedule', label: 'สรุปรายวัน (Daily digest)', hint: 'งานวันนี้ + Overdue + รอ Review', line: true },
  { eventType: 'report.weekly', group: 'schedule', label: 'รายงานสรุปรายสัปดาห์', line: false },
];

export const PREF_EVENTS = new Set(PREF_ROWS.map((r) => r.eventType));

/** ค่าเริ่มต้นของแต่ละช่อง เมื่อผู้ใช้ยังไม่เคยตั้ง */
export function defaultOn(row: PrefRow, channel: PrefChannel): boolean {
  if (channel === 'in_app') return row.eventType !== 'digest.daily';
  if (channel === 'email') return EMAIL_DEFAULT_ON.has(row.eventType);
  return row.line;
}

/** In-app ที่ล็อกไว้ (Profile: "In-app แจ้งทุกเรื่องเสมอสำหรับงานที่มอบหมายให้คุณ") */
export const isLocked = (eventType: string, channel: PrefChannel) => channel === 'in_app' && IN_APP_LOCKED.has(eventType);
