import { Module } from '@nestjs/common';
import { FieldsService } from './fields.service.js';
import { HolidaysService } from './holidays.service.js';
import { ModulesService } from './modules.service.js';
import { ProjectStructureController } from './project-structure.controller.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Module, กลุ่มงาน, Workflow, สถานะ, ประเภทงาน, Label, Custom field, วันหยุด, Milestone · งาน A05 (docs/tasks/A05-*.md)
 * ให้งานอื่นใช้: rules.ts (รายชื่อกฎ Workflow) และ recalculatePlanEnds ใน plan-ends.ts (A18 เมื่อวันหยุดของ Workspace เปลี่ยน)
 */
@Module({
  controllers: [ProjectStructureController],
  providers: [ModulesService, WorkflowsService, FieldsService, HolidaysService],
})
export class ProjectStructureModule {}
