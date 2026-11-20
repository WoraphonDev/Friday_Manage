import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/errors.js';
import { Jobs, UnrecoverableError } from '../queue/jobs.js';
import { IssueMoveService, PreviewMoveBody } from './issue-move.service.js';

/** ชื่องานในคิว · ops-api (สคริปต์ move_issues) ส่งงานชื่อนี้เข้าคิวเดียวกัน (apps/ops-api/src/scripts/remote.ts) */
export const OPS_MOVE_JOB = 'ops.issues_move';

const OpsMoveJob = z.object({
  workspaceId: z.uuid(),
  staffName: z.string().min(1).max(200),
  mode: z.enum(['preview', 'move']),
  input: PreviewMoveBody,
});

/**
 * สคริปต์ Ops "ย้ายงานไปอีกโปรเจกต์" (Story 3) ผ่านคิวงานเดิม · ไม่เปิด endpoint ใหม่ให้ ops-api เรียก
 * ตรรกะการย้ายอยู่ที่ API ที่เดียว (หน้าเว็บกับ Ops ได้ผลเหมือนกัน) · ผลกลับไปเป็น returnvalue ของงาน
 * กติกาไม่ผ่าน (AppError) ไม่ retry และส่ง code / ข้อความกลับให้ Ops แสดง
 */
@Injectable()
export class IssueMoveJobs implements OnModuleInit {
  constructor(
    private readonly jobs: Jobs,
    private readonly moves: IssueMoveService,
  ) {}

  onModuleInit() {
    this.jobs.define(OPS_MOVE_JOB, async (raw: unknown) => {
      const d = OpsMoveJob.parse(raw);
      try {
        return await this.moves.forStaff(d.workspaceId, d.staffName, d.mode, d.input);
      } catch (e) {
        if (e instanceof AppError) throw new UnrecoverableError(JSON.stringify({ code: e.code, message: e.message, details: e.details ?? {} }));
        throw e;
      }
    });
  }
}
