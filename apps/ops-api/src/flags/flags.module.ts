import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { AnnouncementBody, FlagBody, FlagsService, OverrideBody, PatchAnnouncementBody, PatchFlagBody } from './flags.service.js';

/** Feature flag (Owner, วิศวกร · หน้าจอเฟส 3) และประกาศถึงลูกค้า (Owner · เฟส 2) */
@Controller('ops')
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Roles('owner', 'engineer')
  @Get('feature-flags')
  listFlags() {
    return this.flags.listFlags();
  }
  @Roles('owner', 'engineer')
  @Post('feature-flags')
  createFlag(@Body() body: unknown) {
    return this.flags.createFlag(parse(FlagBody, body));
  }
  @Roles('owner', 'engineer')
  @Patch('feature-flags/:id')
  patchFlag(@Param('id') id: string, @Body() body: unknown) {
    return this.flags.patchFlag(id, parse(PatchFlagBody, body));
  }
  @Roles('owner', 'engineer')
  @Delete('feature-flags/:id')
  deleteFlag(@Param('id') id: string) {
    return this.flags.deleteFlag(id);
  }
  @Roles('owner', 'engineer')
  @Put('feature-flags/:id/overrides/:workspaceId')
  setOverride(@Req() req: OpsRequest, @Param('id') id: string, @Param('workspaceId') ws: string, @Body() body: unknown) {
    return this.flags.setOverride(req.staff!, id, ws, parse(OverrideBody, body));
  }
  @Roles('owner', 'engineer')
  @Delete('feature-flags/:id/overrides/:workspaceId')
  removeOverride(@Req() req: OpsRequest, @Param('id') id: string, @Param('workspaceId') ws: string) {
    return this.flags.removeOverride(req.staff!, id, ws);
  }

  @Roles('owner')
  @Get('announcements')
  listAnnouncements() {
    return this.flags.listAnnouncements();
  }
  @Roles('owner')
  @Post('announcements')
  createAnnouncement(@Body() body: unknown) {
    return this.flags.createAnnouncement(parse(AnnouncementBody, body));
  }
  @Roles('owner')
  @Patch('announcements/:id')
  patchAnnouncement(@Param('id') id: string, @Body() body: unknown) {
    return this.flags.patchAnnouncement(id, parse(PatchAnnouncementBody, body));
  }
  @Roles('owner')
  @Delete('announcements/:id')
  deleteAnnouncement(@Param('id') id: string) {
    return this.flags.deleteAnnouncement(id);
  }
  @Roles('owner')
  @Post(['announcements/:id/publish', 'announcements/:id\\:publish'])
  @HttpCode(200)
  publish(@Param('id') id: string) {
    return this.flags.publishAnnouncement(id);
  }
}

@Module({ controllers: [FlagsController], providers: [FlagsService] })
export class FlagsModule {}
