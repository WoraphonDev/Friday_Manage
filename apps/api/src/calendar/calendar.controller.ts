import { Body, Controller, Delete, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Auth, type AuthInfo, Public, Tenant, type TenantInfo } from '../common/request.js';
import { TenantGuard } from '../common/tenant.js';
import { parse } from '../common/validate.js';
import { CalendarService, CreateFeedBody, FeedQuery, MonthQuery } from './calendar.service.js';

@Controller('w/:ws/projects/:key')
@UseGuards(TenantGuard)
export class ProjectCalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('calendar')
  month(@Auth() auth: AuthInfo, @Tenant() tenant: TenantInfo, @Param('key') key: string, @Query() query: unknown) {
    return this.calendar.month(auth, tenant, key, parse(MonthQuery, query));
  }
}

@Controller('me/calendar-feeds')
export class CalendarFeedsController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  list(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.calendar.listFeeds(auth, parse(FeedQuery, query));
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.calendar.createFeed(auth, parse(CreateFeedBody, body));
  }

  @Delete(':id')
  remove(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.calendar.deleteFeed(auth, id);
  }
}

/** ลิงก์ที่แอปปฏิทินดึงเอง ไม่มี session · ความลับอยู่ที่ token ใน URL */
@Controller('ical')
export class IcalController {
  constructor(private readonly calendar: CalendarService) {}

  @Public()
  @Get(':file')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('Content-Disposition', 'inline; filename="friday-manage.ics"')
  ics(@Param('file') file: string) {
    return this.calendar.ics(file);
  }
}
