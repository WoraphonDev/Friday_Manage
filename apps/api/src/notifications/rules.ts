/**
 * กติกาผู้รับแจ้งเตือนใน Inbox (03-api › Event ที่ระบบส่งต่อ คอลัมน์ "ส่งหาใคร")
 * เขียนเป็นข้อมูลไว้ที่เดียว ให้ test และงานช่องทางอื่น (A24 LINE, A25 Email) อ่านกติกาชุดเดียวกัน
 */

/** ชื่อช่องทาง In-app ใน user_notification_prefs (I · Profile คอลัมน์ "In-app") */
export const IN_APP_CHANNEL = 'in_app';

/**
 * เหตุการณ์ที่ In-app ปิดไม่ได้ (Profile: "In-app (Inbox) แจ้งทุกเรื่องเสมอสำหรับงานที่มอบหมายให้คุณ")
 * แถวที่ช่อง In-app ถูกล็อกใน Canvas I: มอบหมาย/ถอดออก, Review, @mention, คำขอเลื่อน Due, เลยกำหนด, ถูกเพิ่มเข้าโปรเจกต์
 */
export const IN_APP_LOCKED = new Set([
  'issue.assigned',
  'issue.review_requested',
  'issue.mentioned',
  'due_request.created',
  'due_request.decided',
  'issue.overdue',
  'member.joined',
]);

/** ส่งอยู่แล้วที่ต้นทาง (due-requests, projects, invitations) · ฟังแล้วต้องไม่ส่งซ้ำ */
export const SENT_AT_SOURCE = new Set(['due_request.created', 'due_request.decided', 'project.admin_joined']);

/** ไม่มีผู้รับเริ่มต้น (ใช้กับ Automation / Webhook) หรือให้งานอื่นส่งเอง */
export const NO_INBOX = new Set(['issue.created', 'issue.deleted', 'report.weekly']);

/** issue.updated แจ้ง Watcher เฉพาะฟิลด์ที่ Profile บอกไว้ (Due / Priority) และฟิลด์หลัก · สถานะและผู้รับผิดชอบมี Event ของตัวเอง */
export const WATCHED_FIELDS = new Set(['planStart', 'planEnd', 'priority', 'severity', 'title']);

/** ชื่อสถานะที่ถือว่า "ขอให้ Review" (03-api: ย้ายเข้าสถานะ Review) */
export const isReviewStatus = (name: unknown) => typeof name === 'string' && name.trim().toLowerCase() === 'review';

/** "ทำไมฉันได้รับแจ้ง" (G · Inbox) */
export const REASONS = {
  assignee: 'คุณได้รับมอบหมายงานนี้',
  unassigned: 'คุณถูกถอดออกจากงานนี้',
  watcher: 'คุณติดตาม (Watch) งานนี้',
  parentAssignee: 'คุณรับผิดชอบงานแม่ของ Sub-task นี้',
  reviewer: 'คุณเป็น Reviewer ของงานนี้',
  mentioned: 'มีคน @mention คุณในคอมเมนต์',
  bugAssignee: 'คุณรับผิดชอบ Bug นี้',
  ba: 'คุณเป็น BA ของงานนี้',
  owner: 'คุณรับผิดชอบงานนี้',
  projectMember: 'คุณเป็นสมาชิกโปรเจกต์นี้',
  pm: 'คุณเป็น PM (Project Owner) ของโปรเจกต์นี้',
  addedToProject: 'คุณถูกเพิ่มเข้าโปรเจกต์นี้',
  importer: 'คุณเป็นผู้นำเข้าไฟล์นี้',
  dueSoon: 'งานของคุณใกล้ครบกำหนด · ตั้งเวลาเตือนได้ที่ Profile › การแจ้งเตือน',
  overdue: 'งานของคุณเลยกำหนดแล้ว',
  overdueSummary: 'สรุปงานเลยกำหนดของโปรเจกต์ที่คุณเป็น PM (วันทำการ 09:30)',
  digest: 'สรุปรายวันที่คุณเปิดไว้ใน Profile',
} as const;

/** ชื่องานตามเวลา (A16 · QUEUE) */
export const JOBS = {
  fanout: 'notifications.fanout',
  dueReminders: 'notifications.due-reminders',
  overdueSummary: 'notifications.overdue-summary',
  digest: 'notifications.digest',
} as const;

/** เวลาไทย (Jobs.every ใช้ Asia/Bangkok) */
export const SCHEDULES = {
  dueReminders: '0 8 * * *',
  overdueSummary: '30 9 * * *',
  digest: '30 8 * * *',
} as const;
