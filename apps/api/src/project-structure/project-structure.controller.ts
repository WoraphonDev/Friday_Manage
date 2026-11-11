import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { Id, ReorderBody } from './context.js';
import { CreateCustomFieldBody, CreateLabelBody, FieldsService, PatchCustomFieldBody, PatchLabelBody } from './fields.service.js';
import { CreateHolidayBody, HolidayQuery, HolidaysService } from './holidays.service.js';
import {
  CreateMilestoneBody, CreateModuleBody, CreatePhaseBody, DeleteModuleBody, DeletePhaseBody, MilestoneIssuesBody,
  ModulesService, PatchMilestoneBody, PatchModuleBody, PatchPhaseBody,
} from './modules.service.js';
import {
  ApplyDevQaBody, CreateRuleBody, CreateStatusBody, DeleteStatusBody, PatchIssueTypeBody, PatchRuleBody, PatchStatusBody, WorkflowsService,
} from './workflows.service.js';

/** DELETE ที่ต้องส่ง moveTo รับได้ทั้ง query (?moveTo=) และ body */
const withQuery = (query: unknown, body: unknown) => ({ ...(query as object), ...((body as object) ?? {}) });

/**
 * L2 · Project Settings รายแท็บ (03-api › 3.5) · ไม่มี GET p/settings แบบรวม หน้าเว็บเรียกรายแท็บ
 * อ่าน: project.view (Guest ไม่เห็น Settings ยกเว้น Milestone) · แก้: project.settings
 */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ProjectStructureController {
  constructor(
    private readonly modules: ModulesService,
    private readonly workflows: WorkflowsService,
    private readonly fields: FieldsService,
    private readonly holidays: HolidaysService,
  ) {}

  // Module -------------------------------------------------------------------
  @Get('modules')
  listModules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.modules.listModules(auth, tenant, key);
  }

  @Post('modules')
  createModule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.modules.createModule(auth, tenant, key, parse(CreateModuleBody, body));
  }

  @Post(['modules/reorder', 'modules\\:reorder'])
  @HttpCode(200)
  reorderModules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.modules.reorderModules(auth, tenant, key, parse(ReorderBody, body));
  }

  @Patch('modules/:id')
  patchModule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.modules.patchModule(auth, tenant, key, parse(Id, id), parse(PatchModuleBody, body));
  }

  @Delete('modules/:id')
  deleteModule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Query() query: unknown, @Body() body: unknown) {
    return this.modules.deleteModule(auth, tenant, key, parse(Id, id), parse(DeleteModuleBody, withQuery(query, body)));
  }

  // กลุ่มงาน -----------------------------------------------------------------
  @Get('modules/:id/phases')
  listPhases(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.modules.listPhases(auth, tenant, key, parse(Id, id));
  }

  @Post('modules/:id/phases')
  createPhase(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.modules.createPhase(auth, tenant, key, parse(Id, id), parse(CreatePhaseBody, body));
  }

  @Post(['modules/:id/phases/reorder', 'modules/:id/phases\\:reorder'])
  @HttpCode(200)
  reorderPhases(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.modules.reorderPhases(auth, tenant, key, parse(Id, id), parse(ReorderBody, body));
  }

  @Patch('modules/:id/phases/:phaseId')
  patchPhase(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('phaseId') phaseId: string, @Body() body: unknown) {
    return this.modules.patchPhase(auth, tenant, key, parse(Id, id), parse(Id, phaseId), parse(PatchPhaseBody, body));
  }

  @Delete('modules/:id/phases/:phaseId')
  deletePhase(
    @Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('phaseId') phaseId: string,
    @Query() query: unknown, @Body() body: unknown,
  ) {
    return this.modules.deletePhase(auth, tenant, key, parse(Id, id), parse(Id, phaseId), parse(DeletePhaseBody, withQuery(query, body)));
  }

  // Milestone ----------------------------------------------------------------
  @Get('milestones')
  listMilestones(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.modules.listMilestones(auth, tenant, key);
  }

  @Post('milestones')
  createMilestone(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.modules.createMilestone(auth, tenant, key, parse(CreateMilestoneBody, body));
  }

  @Patch('milestones/:id')
  patchMilestone(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.modules.patchMilestone(auth, tenant, key, parse(Id, id), parse(PatchMilestoneBody, body));
  }

  @Delete('milestones/:id')
  @HttpCode(204)
  deleteMilestone(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.modules.deleteMilestone(auth, tenant, key, parse(Id, id));
  }

  @Get('milestones/:id/issues')
  milestoneIssues(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.modules.milestoneIssues(auth, tenant, key, parse(Id, id));
  }

  @Post('milestones/:id/issues')
  @HttpCode(200)
  addMilestoneIssues(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.modules.addMilestoneIssues(auth, tenant, key, parse(Id, id), parse(MilestoneIssuesBody, body));
  }

  @Delete('milestones/:id/issues/:issueKey')
  @HttpCode(204)
  removeMilestoneIssue(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('issueKey') issueKey: string) {
    return this.modules.removeMilestoneIssue(auth, tenant, key, parse(Id, id), issueKey);
  }

  // Workflow + สถานะ + กฎ -----------------------------------------------------
  @Get('workflows')
  listWorkflows(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.workflows.listWorkflows(auth, tenant, key);
  }

  @Get('workflows/:id/statuses')
  listStatuses(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.workflows.listStatuses(auth, tenant, key, parse(Id, id));
  }

  @Post('workflows/:id/statuses')
  createStatus(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.createStatus(auth, tenant, key, parse(Id, id), parse(CreateStatusBody, body));
  }

  @Post(['workflows/:id/statuses/reorder', 'workflows/:id/statuses\\:reorder'])
  @HttpCode(200)
  reorderStatuses(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.reorderStatuses(auth, tenant, key, parse(Id, id), parse(ReorderBody, body));
  }

  @Post('workflows/:id/apply-dev-qa')
  @HttpCode(200)
  applyDevQa(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.applyDevQa(auth, tenant, key, parse(Id, id), parse(ApplyDevQaBody, body));
  }

  @Patch('workflows/:id/statuses/:statusId')
  patchStatus(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('statusId') statusId: string, @Body() body: unknown) {
    return this.workflows.patchStatus(auth, tenant, key, parse(Id, id), parse(Id, statusId), parse(PatchStatusBody, body));
  }

  @Delete('workflows/:id/statuses/:statusId')
  deleteStatus(
    @Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('statusId') statusId: string,
    @Query() query: unknown, @Body() body: unknown,
  ) {
    return this.workflows.deleteStatus(auth, tenant, key, parse(Id, id), parse(Id, statusId), parse(DeleteStatusBody, withQuery(query, body)));
  }

  @Get('workflows/:id/rules')
  listRules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.workflows.listRules(auth, tenant, key, parse(Id, id));
  }

  @Post('workflows/:id/rules')
  createRule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.createRule(auth, tenant, key, parse(Id, id), parse(CreateRuleBody, body));
  }

  @Patch('workflows/:id/rules/:ruleId')
  patchRule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.workflows.patchRule(auth, tenant, key, parse(Id, id), parse(Id, ruleId), parse(PatchRuleBody, body));
  }

  @Delete('workflows/:id/rules/:ruleId')
  @HttpCode(204)
  deleteRule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Param('ruleId') ruleId: string) {
    return this.workflows.deleteRule(auth, tenant, key, parse(Id, id), parse(Id, ruleId));
  }

  // ประเภทงาน ---------------------------------------------------------------
  @Get('issue-types')
  listIssueTypes(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.workflows.listIssueTypes(auth, tenant, key);
  }

  @Get('issue-types/:id')
  getIssueType(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.workflows.getIssueType(auth, tenant, key, parse(Id, id));
  }

  @Patch('issue-types/:id')
  patchIssueType(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.patchIssueType(auth, tenant, key, parse(Id, id), parse(PatchIssueTypeBody, body));
  }

  // Custom field และ Label -------------------------------------------------------
  @Get('custom-fields')
  listCustomFields(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.fields.listCustomFields(auth, tenant, key);
  }

  @Post('custom-fields')
  createCustomField(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.fields.createCustomField(auth, tenant, key, parse(CreateCustomFieldBody, body));
  }

  @Patch('custom-fields/:id')
  patchCustomField(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.fields.patchCustomField(auth, tenant, key, parse(Id, id), parse(PatchCustomFieldBody, body));
  }

  @Delete('custom-fields/:id')
  @HttpCode(204)
  deleteCustomField(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.fields.deleteCustomField(auth, tenant, key, parse(Id, id));
  }

  @Get('labels')
  listLabels(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.fields.listLabels(auth, tenant, key);
  }

  @Post('labels')
  createLabel(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.fields.createLabel(auth, tenant, key, parse(CreateLabelBody, body));
  }

  @Patch('labels/:id')
  patchLabel(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string, @Body() body: unknown) {
    return this.fields.patchLabel(auth, tenant, key, parse(Id, id), parse(PatchLabelBody, body));
  }

  @Delete('labels/:id')
  @HttpCode(204)
  deleteLabel(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.fields.deleteLabel(auth, tenant, key, parse(Id, id));
  }

  // วันหยุดของโปรเจกต์ ----------------------------------------------------------
  @Get('holidays')
  listHolidays(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.holidays.list(auth, tenant, key, parse(HolidayQuery, query));
  }

  @Post('holidays')
  createHoliday(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.holidays.create(auth, tenant, key, parse(CreateHolidayBody, body));
  }

  @Delete('holidays/:id')
  deleteHoliday(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Param('id') id: string) {
    return this.holidays.remove(auth, tenant, key, parse(Id, id));
  }
}
