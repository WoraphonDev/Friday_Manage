import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { z } from 'zod';
import { ChannelsService, CreateWebhookBody, DeliveriesQuery, EmailBody, PatchWebhookBody, PreviewQuery } from './channels.service.js';
import { ProjectNotifyService, RulesBody, ScheduleBody, SettingsBody } from './project-notify.service.js';

const Id = z.string().uuid();
const EventName = z.string().regex(/^[a-z_]+\.[a-z_]+$/);

/** Admin Console › ช่องทางแจ้งเตือน (N1) และหน้าตาข้อความ (N2) · Owner / Admin เท่านั้น (`ws.settings`) */
@Controller('w/:ws')
@UseGuards(TenantGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('channels/email')
  getEmail(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.channels.getEmail(auth, tenant);
  }

  @Put('channels/email')
  putEmail(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.channels.putEmail(auth, tenant, parse(EmailBody, body));
  }

  @Post(['channels/email/verify-dns', 'channels/email\\:verify-dns'])
  @HttpCode(200)
  verifyDns(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.channels.verifyDns(auth, tenant);
  }

  @Post(['channels/email/test', 'channels/email\\:test'])
  @HttpCode(200)
  testEmail(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.channels.testEmail(auth, tenant);
  }

  @Get('channels/webhooks')
  listWebhooks(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo) {
    return this.channels.listWebhooks(auth, tenant);
  }

  @Post('channels/webhooks')
  createWebhook(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Body() body: unknown) {
    return this.channels.createWebhook(auth, tenant, parse(CreateWebhookBody, body));
  }

  @Patch('channels/webhooks/:id')
  patchWebhook(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.channels.patchWebhook(auth, tenant, parse(Id, id), parse(PatchWebhookBody, body));
  }

  @Delete('channels/webhooks/:id')
  deleteWebhook(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.channels.deleteWebhook(auth, tenant, parse(Id, id));
  }

  @Post(['channels/webhooks/:id/test', 'channels/webhooks/:id\\:test'])
  @HttpCode(200)
  testWebhook(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('id') id: string) {
    return this.channels.testWebhook(auth, tenant, parse(Id, id));
  }

  @Get('channels/deliveries')
  deliveries(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Query() query: unknown) {
    return this.channels.deliveries(auth, tenant, parse(DeliveriesQuery, query));
  }

  @Get(['notification-templates/:event/preview', 'notification-templates/:event\\:preview'])
  preview(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('event') event: string, @Query() query: unknown) {
    return this.channels.preview(auth, tenant, parse(EventName, event), parse(PreviewQuery, query));
  }
}

/** L2 › การแจ้งเตือนของโปรเจกต์ · O2 › ตั้งเวลาส่งรายงาน */
@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ProjectNotifyController {
  constructor(private readonly notify: ProjectNotifyService) {}

  @Get('notification-rules')
  getRules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.notify.getRules(auth, tenant, key);
  }

  @Put('notification-rules')
  putRules(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.notify.putRules(auth, tenant, key, parse(RulesBody, body));
  }

  @Get('notification-settings')
  getSettings(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.notify.getSettings(auth, tenant, key);
  }

  @Put('notification-settings')
  putSettings(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.notify.putSettings(auth, tenant, key, parse(SettingsBody, body));
  }

  @Get('report-schedule')
  getSchedule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.notify.getSchedule(auth, tenant, key);
  }

  @Put('report-schedule')
  putSchedule(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Body() body: unknown) {
    return this.notify.putSchedule(auth, tenant, key, parse(ScheduleBody, body));
  }

  @Post(['reports/weekly/send', 'reports/weekly\\:send'])
  @HttpCode(200)
  sendWeekly(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string) {
    return this.notify.sendWeekly(auth, tenant, key);
  }
}
