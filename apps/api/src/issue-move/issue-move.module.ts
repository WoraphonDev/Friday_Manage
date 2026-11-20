import { Module } from '@nestjs/common';
import { IssueMoveController } from './issue-move.controller.js';
import { IssueMoveJobs } from './issue-move.jobs.js';
import { IssueMoveService } from './issue-move.service.js';

/** ย้ายงานข้ามโปรเจกต์ (ผู้ใช้อนุมัติ storyboard 2026-11-20) · Ops เรียก service เดียวกันผ่าน API */
@Module({
  controllers: [IssueMoveController],
  providers: [IssueMoveService, IssueMoveJobs],
  exports: [IssueMoveService],
})
export class IssueMoveModule {}
