import { z } from 'zod';
import { SUPPORTED_WORKFLOW_RULE_TYPES } from '../issues/rules.js';

/**
 * กฎของ Workflow (L2 › Workflow › กฎการย้ายสถานะ)
 * ชื่อกฎและการตรวจอยู่ใน issues/rules.ts (A03 ประกาศไว้ก่อน) · ไฟล์นี้ใช้รายชื่อเดียวกันแล้วเพิ่มคำอธิบายของหน้าจอ
 * จึงเพิ่มชื่อกฎได้ที่เดียว และ `satisfies` บังคับให้ทุกชื่อมีคำอธิบายที่นี่
 */
export { enforceWorkflowRules, SUPPORTED_WORKFLOW_RULE_TYPES, workflowRuleEnabled } from '../issues/rules.js';

export type WorkflowRuleType = (typeof SUPPORTED_WORKFLOW_RULE_TYPES)[number];
export type WorkflowKind = 'standard' | 'bug';

interface RuleSpec {
  /** transition = บล็อกการย้าย (422) · warning = เตือนแต่ย้ายได้ · event = ทำงานเมื่อมีเหตุการณ์ (QA / Automation) */
  kind: 'transition' | 'warning' | 'event';
  /** Workflow ที่หน้าจอแสดงกฎนี้ */
  workflow: WorkflowKind;
  title: string;
  description: string;
  /** ค่าเริ่มต้นของหน้าจอเมื่อสร้างโปรเจกต์ใหม่ */
  defaultEnabled: boolean;
  /** พฤติกรรมเมื่อ Workflow ยังไม่มีแถวของกฎนี้ (ตรงกับ workflowRuleEnabled ใน issues/rules.ts) */
  implicitEnabled: boolean;
}

export const WORKFLOW_RULES = {
  subtasks_done: {
    kind: 'transition', workflow: 'standard', defaultEnabled: true, implicitEnabled: true,
    title: 'ย้ายไป Done ไม่ได้ถ้า Sub-task ยังไม่เสร็จครบ', description: 'จะเตือนและให้เลือกปิด Sub-task ทั้งหมดพร้อมกัน',
  },
  reviewer_required: {
    kind: 'transition', workflow: 'standard', defaultEnabled: true, implicitEnabled: false,
    title: 'ย้ายไป Review ต้องมี Reviewer', description: 'ระบบถามหา Reviewer ก่อนย้าย',
  },
  wip_warning: {
    kind: 'warning', workflow: 'standard', defaultEnabled: true, implicitEnabled: true,
    title: 'เตือนเมื่อคอลัมน์เกิน WIP limit', description: 'ยังย้ายได้ แต่หัวคอลัมน์เป็นสีแดง',
  },
  reviewer_only_done: {
    kind: 'transition', workflow: 'standard', defaultEnabled: false, implicitEnabled: false,
    title: 'เฉพาะ Reviewer ย้าย Review → Done', description: 'Assignee ปิดงานตัวเองไม่ได้',
  },
  fix_reference_required: {
    kind: 'transition', workflow: 'bug', defaultEnabled: true, implicitEnabled: false,
    title: 'ส่ง Fixed ต้องระบุ Commit หรือ PR ที่แก้', description: 'ป้องกันการปิด Bug โดยไม่มีหลักฐาน',
  },
  tester_or_reporter_only_verified: {
    kind: 'transition', workflow: 'bug', defaultEnabled: true, implicitEnabled: false,
    title: 'เฉพาะ Tester หรือ Reporter ย้าย Fixed → Verified', description: 'Dev ยืนยันผลงานตัวเองไม่ได้',
  },
  reopen_on_failed_test: {
    kind: 'event', workflow: 'bug', defaultEnabled: true, implicitEnabled: false,
    title: 'Reopen อัตโนมัติถ้าผลทดสอบซ้ำไม่ผ่าน', description: 'เมื่อแนบผลทดสอบที่ Failed ในงานที่ผูกกับ Bug นี้',
  },
  critical_auto_start: {
    kind: 'event', workflow: 'bug', defaultEnabled: false, implicitEnabled: false,
    title: 'Bug Critical ข้ามไป In progress ทันทีและแจ้ง PM', description: 'ไม่ต้องรอคนรับงาน',
  },
} as const satisfies Record<WorkflowRuleType, RuleSpec>;

export const ruleType = z.enum(SUPPORTED_WORKFLOW_RULE_TYPES);

/** config ที่ issues/rules.ts อ่าน: จำกัดคู่สถานะต้นทาง / ปลายทาง (ต้องเป็นสถานะใน Workflow เดียวกัน) */
export const RuleConfig = z
  .object({ fromStatusId: z.uuid().optional(), toStatusId: z.uuid().optional() })
  .strict()
  .refine((c) => !c.fromStatusId || c.fromStatusId !== c.toStatusId, { path: ['toStatusId'], message: 'สถานะต้นทางและปลายทางต้องต่างกัน' });
export type RuleConfig = z.infer<typeof RuleConfig>;

/** แถวกฎเริ่มต้นตามหน้าจอ L2 สำหรับ Workflow ใหม่ (ให้ A04 ใช้ตอนสร้างโปรเจกต์) */
export function defaultWorkflowRules(kind: WorkflowKind) {
  return (Object.entries(WORKFLOW_RULES) as [WorkflowRuleType, RuleSpec][])
    .filter(([, r]) => r.workflow === kind)
    .map(([type, r]) => ({ ruleType: type, enabled: r.defaultEnabled, config: {} as RuleConfig }));
}

/** รายการกฎที่หน้าจอแสดงสำหรับ Workflow นี้ พร้อมสถานะที่มีผลจริง (มีแถว = ตามแถว · ไม่มีแถว = implicitEnabled) */
export function ruleCatalog(kind: WorkflowKind, rows: { ruleType: string; enabled: boolean }[]) {
  return (Object.entries(WORKFLOW_RULES) as [WorkflowRuleType, RuleSpec][])
    .filter(([type, r]) => r.workflow === kind || rows.some((x) => x.ruleType === type))
    .map(([type, r]) => {
      const mine = rows.filter((x) => x.ruleType === type);
      return {
        ruleType: type,
        kind: r.kind,
        workflow: r.workflow,
        title: r.title,
        description: r.description,
        defaultEnabled: r.defaultEnabled,
        configured: mine.length > 0,
        enabled: mine.length ? mine.some((x) => x.enabled) : r.implicitEnabled,
      };
    });
}
