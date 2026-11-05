import { schema as s, type Tx } from '@friday/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { AppError } from '../common/errors.js';
import type { AuthInfo } from '../common/request.js';

type Issue = typeof s.issues.$inferSelect;
type Status = typeof s.workflowStatuses.$inferSelect;

/** ชื่อกฎที่ A05 ใช้บันทึกได้ · config.toStatusId / fromStatusId จำกัดคู่สถานะได้ */
export const SUPPORTED_WORKFLOW_RULE_TYPES = [
  'subtasks_done', 'reviewer_required', 'reviewer_only_done', 'fix_reference_required', 'tester_or_reporter_only_verified',
  'wip_warning', 'reopen_on_failed_test', 'critical_auto_start',
] as const;

/** ตรวจเฉพาะกฎการย้ายสถานะ ส่วนกฎตอบ Event เป็นหน้าที่ QA / Automation */
export async function enforceWorkflowRules(tx: Tx, auth: AuthInfo, issue: Issue, workflowId: string, next: Status, proposed: Issue, confirm: boolean) {
  const rules = await tx.select().from(s.workflowRules).where(and(eq(s.workflowRules.workflowId, workflowId), eq(s.workflowRules.enabled, true)));
  if (!rules.length) return;
  const [current] = await tx.select().from(s.workflowStatuses).where(eq(s.workflowStatuses.id, issue.statusId));
  for (const rule of rules) {
    const config = rule.config as { toStatusId?: string; fromStatusId?: string };
    if (config.toStatusId && config.toStatusId !== next.id) continue;
    if (config.fromStatusId && config.fromStatusId !== current.id) continue;
    const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => {
      throw new AppError(422, code, message, { ruleId: rule.id, ruleType: rule.ruleType, ...extra });
    };
    switch (rule.ruleType) {
      case 'subtasks_done': {
        if (next.category !== 'done' || current.category === 'done') break;
        const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.issues)
          .innerJoin(s.workflowStatuses, eq(s.workflowStatuses.id, s.issues.statusId))
          .where(and(eq(s.issues.parentId, issue.id), isNull(s.issues.deletedAt), ne(s.workflowStatuses.category, 'done')));
        if (open.n && !confirm) fail('subtasks_incomplete', `ยังมี Sub-task ที่ไม่เสร็จ ${open.n} งาน`, { open: open.n, confirmable: true });
        break;
      }
      case 'reviewer_required':
        if ((config.toStatusId || next.name.toLowerCase() === 'review') && !proposed.reviewerId) fail('reviewer_required', 'ต้องระบุ Reviewer ก่อนย้ายไป Review');
        break;
      case 'reviewer_only_done':
        if (next.category === 'done' && (config.fromStatusId || current.name.toLowerCase() === 'review') && proposed.reviewerId !== auth.userId) fail('reviewer_only_done', 'เฉพาะ Reviewer เท่านั้นที่ย้ายจาก Review ไป Done ได้');
        break;
      case 'fix_reference_required': {
        if (!config.toStatusId && next.name.toLowerCase() !== 'fixed') break;
        const [link] = await tx.select({ id: s.issueGitLinks.id }).from(s.issueGitLinks).where(eq(s.issueGitLinks.issueId, issue.id)).limit(1);
        if (!link) fail('fix_reference_required', 'ต้องแนบ Commit หรือ PR ที่แก้ก่อนย้ายไป Fixed');
        break;
      }
      case 'tester_or_reporter_only_verified':
        if ((config.toStatusId || next.name.toLowerCase() === 'verified') && auth.userId !== proposed.testerId && auth.userId !== proposed.reporterId) fail('tester_or_reporter_only_verified', 'เฉพาะ Tester หรือ Reporter เท่านั้นที่ย้ายไป Verified ได้');
        break;
      case 'wip_warning':
      case 'reopen_on_failed_test':
      case 'critical_auto_start':
        break;
      default:
        // กฎใหม่ที่ยังตรวจไม่ได้ต้องไม่ปล่อยข้ามโดยเงียบ
        fail('unsupported_workflow_rule', 'กฎ Workflow นี้ยังไม่รองรับการย้ายสถานะ');
    }
  }
}

/** โปรเจกต์เก่ายังไม่มีแถวกฎ ใช้พฤติกรรม Kanban เดิมจนกว่า A05 จะบันทึกการตั้งค่า */
export async function workflowRuleEnabled(tx: Tx, workflowId: string, ruleType: string, fallback = true) {
  const rules = await tx.select({ enabled: s.workflowRules.enabled }).from(s.workflowRules)
    .where(and(eq(s.workflowRules.workflowId, workflowId), eq(s.workflowRules.ruleType, ruleType)));
  return rules.length ? rules.some((r) => r.enabled) : fallback;
}
