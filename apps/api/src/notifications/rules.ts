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
  // สรุปงานประจำวันแทนการเตือนใกล้ครบกำหนด / เลยกำหนด ซึ่งเดิมล็อก In-app ไว้
  'digest.daily',
]);

/** สรุปงานประจำวัน 08:30 (Reminders.daily) · ใช้ชื่อเหตุการณ์เดิมของ Daily digest เพื่อให้ค่าใน Profile ที่ผู้ใช้ตั้งไว้ยังใช้ได้ */
export const DAILY_EVENT = 'digest.daily';

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
  pmAdmin: 'คุณเป็น Admin ของโปรเจกต์นี้',
  pmDeputy: 'คุณได้รับมอบหมายให้ทำแทน PM ในโปรเจกต์นี้',
  addedToProject: 'คุณถูกเพิ่มเข้าโปรเจกต์นี้',
  importer: 'คุณเป็นผู้นำเข้าไฟล์นี้',
  dueSoon: 'งานของคุณใกล้ครบกำหนด · ตั้งเวลาเตือนได้ที่ Profile › การแจ้งเตือน',
  overdue: 'งานของคุณเลยกำหนดแล้ว',
  daily: 'สรุปงานประจำวันของคุณ (ใกล้ครบกำหนด · วันนี้ · เลยกำหนด · รอ Review) · ตั้งค่าได้ที่ Profile › การแจ้งเตือน',
} as const;

/** ชื่องานตามเวลา (A16 · QUEUE) */
export const JOBS = {
  fanout: 'notifications.fanout',
  digest: 'notifications.digest',
} as const;

/** เวลาไทย (Jobs.every ใช้ Asia/Bangkok) */
export const SCHEDULES = {
  digest: '30 8 * * *',
} as const;

/** งานตามเวลาที่รวมเข้าสรุปประจำวันแล้ว (12 พ.ย. 2026) · ลบออกจาก Valkey ตอนเปิดแอป ไม่ให้ Worker ได้งานที่ไม่รู้จัก */
export const RETIRED_JOBS = ['notifications.due-reminders', 'notifications.overdue-summary'] as const;

/**
 * "ทำไมฉันได้รับแจ้ง" ภาษาอังกฤษสำหรับ Email / LINE ของผู้ใช้ที่เลือกภาษาอังกฤษ (W21)
 * แถวแจ้งเตือนเก็บเหตุผลเป็นข้อความไทย จึงแปลตอนส่ง · ข้อความที่ไม่มีในนี้ส่งตามเดิม
 */
const REASONS_EN: Record<string, string> = {
  [REASONS.assignee]: 'you are assigned to this task',
  [REASONS.unassigned]: 'you were removed from this task',
  [REASONS.watcher]: 'you watch this task',
  [REASONS.parentAssignee]: 'you own the parent task of this sub-task',
  [REASONS.reviewer]: 'you are the reviewer of this task',
  [REASONS.mentioned]: 'someone @mentioned you in a comment',
  [REASONS.bugAssignee]: 'you own this bug',
  [REASONS.ba]: 'you are the BA of this task',
  [REASONS.owner]: 'you own this task',
  [REASONS.projectMember]: 'you are a member of this project',
  [REASONS.pm]: 'you are the PM (Project Owner) of this project',
  [REASONS.pmAdmin]: 'you are an Admin of this project',
  [REASONS.pmDeputy]: 'you act for the PM in this project',
  [REASONS.addedToProject]: 'you were added to this project',
  [REASONS.importer]: 'you imported this file',
  [REASONS.dueSoon]: 'your task is due soon · change the reminder in Profile › Notifications',
  [REASONS.overdue]: 'your task is overdue',
  [REASONS.daily]: 'your daily summary (due soon · today · overdue · to review) · change it in Profile › Notifications',
  'คุณเป็นผู้อนุมัติ (Project Owner)': 'you approve due date requests (Project Owner)',
  'คุณเป็นผู้อนุมัติคำขอเลื่อน Due ของโปรเจกต์นี้': 'you approve due date requests in this project',
  'คุณเป็นผู้ขอเลื่อน Due': 'you asked to move the due date',
  'คุณเป็น Project Owner': 'you are the Project Owner',
  'คุณได้รับโอนเป็น Project Owner': 'you became the Project Owner',
  'คุณเป็นผู้เชิญ': 'you sent the invitation',
  'คุณอยู่ในรายชื่อผู้รับรายงานรายสัปดาห์ของโปรเจกต์นี้': 'you receive the weekly report of this project',
  'คุณมอบหมายงาน หรือเป็น PM ของงานที่ผู้ลารับผิดชอบอยู่': 'you assigned work to, or are the PM of, someone taking leave',
  'มีเหตุการณ์ที่เกี่ยวข้องกับคุณ': 'something related to you happened',
};

export const reasonIn = (locale: 'th' | 'en', why: string) => (locale === 'en' ? (REASONS_EN[why] ?? why) : why);
