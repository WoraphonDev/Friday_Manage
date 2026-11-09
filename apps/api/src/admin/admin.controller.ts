import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { type AppRequest, Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { AdminService, AuditQuery, PatchSecurityBody, PatchSettingsBody } from './admin.service.js';
import { CalendarsService, CreateCalendarBody, CreateHolidayBody, HolidaysQuery } from './calendars.service.js';
import { MembersBody, PatchTeamBody, TeamBody, TeamsService } from './teams.service.js';
import { CreateTemplateBody, PatchTemplateBody, TemplatesService } from './templates.service.js';

/** Admin Console (N1) · 03-api › 3.3 · Owner / Admin ทุกข้อ */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly calendars: CalendarsService,
    private readonly templates: TemplatesService,
    private readonly teams: TeamsService,
  ) {}

  @Get('admin/overview')
  overview(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.admin.overview(a, t);
  }

  @Get('settings')
  settings(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.admin.getSettings(a, t);
  }
  @Patch('settings')
  patchSettings(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.admin.patchSettings(a, t, parse(PatchSettingsBody, body));
  }

  @Get('security-policy')
  security(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.admin.getSecurity(a, t);
  }
  @Patch('security-policy')
  patchSecurity(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown, @Req() req: AppRequest) {
    return this.admin.patchSecurity(a, t, parse(PatchSecurityBody, body), req.ip);
  }

  // ปฏิทินวันหยุด
  @Get('holiday-calendars')
  listCalendars(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.calendars.listCalendars(a, t);
  }
  @Post('holiday-calendars')
  createCalendar(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.calendars.createCalendar(a, t, parse(CreateCalendarBody, body));
  }
  @Delete('holiday-calendars/:id')
  removeCalendar(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.calendars.removeCalendar(a, t, id);
  }
  @Get('holidays')
  listHolidays(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() q: unknown) {
    return this.calendars.listHolidays(a, t, parse(HolidaysQuery, q));
  }
  @Post('holidays')
  addHoliday(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.calendars.addHoliday(a, t, parse(CreateHolidayBody, body));
  }
  @Delete('holidays/:id')
  removeHoliday(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.calendars.removeHoliday(a, t, id);
  }

  // Template โปรเจกต์
  @Get('project-templates')
  listTemplates(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.templates.list(a, t);
  }
  @Get('project-templates/:id')
  getTemplate(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.templates.get(a, t, id);
  }
  @Post('project-templates')
  createTemplate(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.templates.create(a, t, parse(CreateTemplateBody, body));
  }
  @Patch('project-templates/:id')
  patchTemplate(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.templates.patch(a, t, id, parse(PatchTemplateBody, body));
  }
  @Delete('project-templates/:id')
  removeTemplate(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.templates.remove(a, t, id);
  }

  // ทีม
  @Get('teams')
  listTeams(@Auth() a: AuthInfo, @Tenant() t: TenantInfo) {
    return this.teams.list(a, t);
  }
  @Get('teams/:id')
  getTeam(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.teams.get(a, t, id);
  }
  @Post('teams')
  createTeam(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Body() body: unknown) {
    return this.teams.create(a, t, parse(TeamBody, body));
  }
  @Patch('teams/:id')
  patchTeam(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.teams.patch(a, t, id, parse(PatchTeamBody, body));
  }
  @Delete('teams/:id')
  removeTeam(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string) {
    return this.teams.remove(a, t, id);
  }
  @Post('teams/:id/members')
  addTeamMembers(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.teams.addMembers(a, t, id, parse(MembersBody, body));
  }
  @Delete('teams/:id/members/:userId')
  removeTeamMember(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Param('id') id: string, @Param('userId') userId: string) {
    return this.teams.removeMember(a, t, id, userId);
  }

  // Audit log
  @Get('audit-log')
  auditLog(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() q: unknown) {
    return this.admin.auditLog(a, t, parse(AuditQuery, q));
  }
  @Get('audit-log.csv')
  async auditCsv(@Auth() a: AuthInfo, @Tenant() t: TenantInfo, @Query() q: unknown, @Res() res: Response) {
    const file = await this.admin.auditCsv(a, t, parse(AuditQuery, q));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.filename}"` }).send(file.content);
  }
}
