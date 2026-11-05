import { Module } from '@nestjs/common';
import { ProjectMembersService } from './project-members.service.js';
import { ProjectsController } from './projects.controller.js';
import { SampleProjectService } from './sample-project.service.js';

/** โปรเจกต์ (ProjectsService อยู่ใน CoreModule) · งาน: A04 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectMembersService, SampleProjectService],
})
export class ProjectsModule {}
