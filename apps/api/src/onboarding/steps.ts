// ขั้นของ Onboarding checklist (A43 · หน้าจอ V1–V4) · แก้ขั้นในไฟล์นี้ตามคำตัดสิน 12 พ.ย. 2569 (ยังไม่ทำ V6 แก้จากหลังบ้าน)
// เพิ่ม / ลบ / เปลี่ยนเงื่อนไขของขั้นให้เพิ่ม ONBOARDING_VERSION เพื่อให้ตัวเลขใน Friday Ops แยกตามเวอร์ชัน
// Friday Ops (apps/ops-api/src/onboarding) อ่านรหัสขั้นจาก onboarding_progress · เปลี่ยนรหัสต้องแก้ชื่อขั้นที่นั่นด้วย

/** เลขเวอร์ชันของชุดขั้น (onboarding_progress.version) */
export const ONBOARDING_VERSION = 1;

/**
 * วันเปิดฟีเจอร์ · Workspace ที่สร้างก่อนวันนี้และ "เริ่มใช้จริง" แล้วไม่เห็นการ์ด (ใช้งานเป็นอยู่แล้ว)
 * สมาชิกที่เข้าร่วมก่อนวันนี้ก็ไม่เห็นรายการส่วนตัว (V3 มีไว้ให้สมาชิกใหม่)
 */
export const ONBOARDING_LAUNCHED_AT = new Date('2026-11-12T00:00:00+07:00');

/** นิยาม "เริ่มใช้จริง" (05-business-metrics › 2): สมาชิก ≥ 3 คน และงาน ≥ 10 งาน */
export const ACTIVATION = { members: 3, issues: 10 } as const;

/** ปุ่มของขั้น · path ต่อจาก /work/{ws}/ ของเว็บ (หน้าเว็บประกอบลิงก์เอง) */
export type StepAction = 'new_project' | 'import' | 'invite' | 'table' | 'kanban' | 'notify_settings' | 'profile_hours' | 'open_issue';

export interface StepDef {
  key: string;
  /** ข้อความไทยของขั้น (หน้าเว็บมีข้อความตามภาษาของตัวเองโดยใช้ key เดียวกัน) */
  title: string;
  /** เป้าหมายของตัวเลขประกอบ เช่น 10 งาน · 2 คน */
  target: number;
  action: StepAction | null;
}

/** ขั้นของ Workspace (Owner / Admin เห็น) · ตรวจจากข้อมูลจริง ไม่ใช่การกดติ๊ก */
export const WORKSPACE_STEPS = [
  { key: 'first_project', title: 'สร้าง Workspace และโปรเจกต์แรก', target: 1, action: 'new_project' },
  { key: 'issues', title: 'สร้างงานอย่างน้อย 10 งาน', target: ACTIVATION.issues, action: 'import' },
  // เป้าหมายแสดงเป็น "เพื่อนร่วมทีม 2 คน" · เงื่อนไขจริงคือสมาชิกที่ตอบรับ ≥ 3 รวมเจ้าของ ไม่นับ Guest
  { key: 'team', title: 'ชวนเพื่อนร่วมทีมอย่างน้อย 2 คน', target: ACTIVATION.members - 1, action: 'invite' },
  { key: 'assign_due', title: 'มอบหมายงานและตั้ง Due ให้คนในทีม', target: 5, action: 'table' },
  { key: 'status_update', title: 'อัปเดตสถานะงานหรือย้ายการ์ดใน Kanban', target: 1, action: 'kanban' },
  { key: 'notifications', title: 'รับแจ้งเตือนทาง LINE หรืออีเมล', target: 1, action: 'notify_settings' },
] as const satisfies readonly StepDef[];

/** ขั้นส่วนตัวของสมาชิก (V3 · บทบาท Member) */
export const MEMBER_STEPS = [
  { key: 'profile', title: 'ตั้งรูปโปรไฟล์และเวลาทำงาน', target: 1, action: 'profile_hours' },
  { key: 'open_assigned', title: 'เปิดงานแรกที่ได้รับมอบหมาย', target: 1, action: 'open_issue' },
  { key: 'notify_channel', title: 'เลือกช่องทางแจ้งเตือนของฉัน', target: 1, action: 'notify_settings' },
] as const satisfies readonly StepDef[];

export type WorkspaceStepKey = (typeof WORKSPACE_STEPS)[number]['key'];
export type MemberStepKey = (typeof MEMBER_STEPS)[number]['key'];

/** ตัวเลขของ Workspace ที่ใช้ตัดสินขั้น · at = เวลาที่เงื่อนไขเป็นจริง (ถ้าหาได้) ใช้เป็น done_at ให้เวลาเฉลี่ยใน Ops ถูกต้อง */
export interface WorkspaceCounts {
  projects: number;
  firstProjectAt: Date | null;
  issues: number;
  tenthIssueAt: Date | null;
  /** สมาชิก active ที่ไม่ใช่ Guest รวมเจ้าของ */
  members: number;
  thirdMemberAt: Date | null;
  assignedWithDue: number;
  statusChanges: number;
  firstStatusAt: Date | null;
  /** สมาชิกที่ผูก LINE หรือบันทึกการตั้งค่าแจ้งเตือน (อีเมล) แล้ว */
  notifyMembers: number;
  firstNotifyAt: Date | null;
}

/** ขั้นที่เงื่อนไขเป็นจริงตอนนี้ พร้อมเวลาและตัวเลขประกอบ (meta เป็นตัวเลขเท่านั้น) */
export function metWorkspaceSteps(c: WorkspaceCounts): { key: WorkspaceStepKey; at: Date | null; meta: Record<string, number> }[] {
  const out: { key: WorkspaceStepKey; at: Date | null; meta: Record<string, number> }[] = [];
  if (c.projects >= 1) out.push({ key: 'first_project', at: c.firstProjectAt, meta: { count: c.projects } });
  if (c.issues >= ACTIVATION.issues) out.push({ key: 'issues', at: c.tenthIssueAt, meta: { count: c.issues } });
  if (c.members >= ACTIVATION.members) out.push({ key: 'team', at: c.thirdMemberAt, meta: { count: c.members } });
  if (c.assignedWithDue >= 5) out.push({ key: 'assign_due', at: null, meta: { count: c.assignedWithDue } });
  if (c.statusChanges >= 1) out.push({ key: 'status_update', at: c.firstStatusAt, meta: { count: c.statusChanges } });
  if (c.notifyMembers >= 1) out.push({ key: 'notifications', at: c.firstNotifyAt, meta: { count: c.notifyMembers } });
  return out;
}

/** ตัวเลขที่แสดงคู่กับเป้าหมาย (เช่น 12 / 10 งาน · 1 / 2 คน) */
export function currentOf(key: WorkspaceStepKey, c: WorkspaceCounts): number {
  switch (key) {
    case 'first_project':
      return c.projects;
    case 'issues':
      return c.issues;
    case 'team':
      return Math.max(0, c.members - 1);
    case 'assign_due':
      return c.assignedWithDue;
    case 'status_update':
      return c.statusChanges;
    case 'notifications':
      return c.notifyMembers;
  }
}

/** Workspace เก่า (สร้างก่อนเปิดฟีเจอร์) ที่เริ่มใช้จริงแล้ว */
export function isLegacy(createdAt: Date, c: Pick<WorkspaceCounts, 'members' | 'issues'>) {
  return createdAt < ONBOARDING_LAUNCHED_AT && c.members >= ACTIVATION.members && c.issues >= ACTIVATION.issues;
}
