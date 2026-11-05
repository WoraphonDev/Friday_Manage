import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Auth, type AuthInfo } from '../common/request.js';
import { parse } from '../common/validate.js';
import { ListNotificationsQuery, NotificationsService, ReadAllBody, SnoozeBody } from './notifications.service.js';

/** G · Inbox และ K4 · กระดิ่ง (ของผู้ใช้เอง ข้าม Workspace ได้) */
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.notifications.list(auth, parse(ListNotificationsQuery, query));
  }

  @Get('summary')
  summary(@Auth() auth: AuthInfo) {
    return this.notifications.summary(auth);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.notifications.readAll(auth, parse(ReadAllBody, body ?? {}));
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.notifications.mark(auth, id, 'read');
  }

  @Post(':id/unread')
  @HttpCode(200)
  unread(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.notifications.mark(auth, id, 'unread');
  }

  /** "รับทราบ" · ย้ายออกจาก Inbox */
  @Post(':id/done')
  @HttpCode(200)
  done(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.notifications.mark(auth, id, 'done');
  }

  @Post(':id/undone')
  @HttpCode(200)
  undone(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.notifications.mark(auth, id, 'undone');
  }

  /** "เตือนฉันพรุ่งนี้" */
  @Post(':id/snooze')
  @HttpCode(200)
  snooze(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() body: unknown) {
    return this.notifications.snooze(auth, id, parse(SnoozeBody, body));
  }
}
