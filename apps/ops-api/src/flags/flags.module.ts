import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { FlagBody, FlagsService, OverrideBody, PatchFlagBody } from './flags.service.js';

/** Feature flag (Owner, วิศวกร · หน้าจอเฟส 3) · ประกาศถึงลูกค้าอยู่ใน announcements/ (O24) */
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
}

@Module({ controllers: [FlagsController], providers: [FlagsService] })
export class FlagsModule {}
