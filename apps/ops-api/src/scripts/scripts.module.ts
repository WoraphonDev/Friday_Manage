import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { type OpsRequest, Roles } from '../auth/auth.guard.js';
import { parse } from '../errors.js';
import { JobQueue } from '../system/job-queue.js';
import { DryRunBody, RequestBody, RunsQuery, ScriptsService, UndoBody } from './scripts.service.js';

/** ระบบ › สคริปต์ดูแลข้อมูล (O56) · Owner และวิศวกร · อนุมัติ / ปฏิเสธผ่าน /ops/approvals เดิม */
@Controller('ops/scripts')
export class ScriptsController {
  constructor(private readonly scripts: ScriptsService) {}

  @Roles('owner', 'engineer')
  @Get()
  overview(@Req() req: OpsRequest) {
    return this.scripts.overview(req.staff!);
  }
  @Roles('owner', 'engineer')
  @Get('runs')
  runs(@Query() q: unknown) {
    return this.scripts.runs(parse(RunsQuery, q));
  }
  @Roles('owner', 'engineer')
  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.scripts.run(id);
  }
  @Roles('owner', 'engineer')
  @Post(':key/dry-run')
  @HttpCode(200)
  dryRun(@Req() req: OpsRequest, @Param('key') key: string, @Body() body: unknown) {
    return this.scripts.dryRun(req.staff!, key, parse(DryRunBody, body));
  }
  @Roles('owner', 'engineer')
  @Post('runs/:id/request')
  @HttpCode(202)
  request(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.scripts.request(req.staff!, id, parse(RequestBody, body));
  }
  @Roles('owner', 'engineer')
  @Post('runs/:id/stop')
  @HttpCode(200)
  stop(@Req() req: OpsRequest, @Param('id') id: string) {
    return this.scripts.stop(req.staff!, id);
  }
  @Roles('owner', 'engineer')
  @Post('runs/:id/undo')
  @HttpCode(202)
  undo(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.scripts.requestUndo(req.staff!, id, parse(UndoBody, body).reason);
  }
}

@Module({ controllers: [ScriptsController], providers: [ScriptsService, JobQueue], exports: [ScriptsService] })
export class ScriptsModule {}
