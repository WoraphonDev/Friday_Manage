import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';

/** โปรเจกต์ (ProjectsService อยู่ใน CoreModule) · งาน: A04 */
@Module({
  controllers: [ProjectsController],
  providers: [],
})
export class ProjectsModule {}
