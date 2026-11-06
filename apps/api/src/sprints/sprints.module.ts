import { Module, type OnModuleInit } from '@nestjs/common';
import { Jobs } from '../queue/jobs.js';
import { SprintsController } from './sprints.controller.js';
import { SprintsService } from './sprints.service.js';

/** Sprint และ Backlog · งาน A06 */
@Module({
  controllers: [SprintsController],
  providers: [SprintsService],
  exports: [SprintsService],
})
export class SprintsModule implements OnModuleInit {
  constructor(private readonly sprints: SprintsService, private readonly jobs: Jobs) {}
  async onModuleInit() {
    this.jobs.define('sprints.snapshot', () => this.sprints.snapshotAll());
    await this.jobs.every('sprints.snapshot', '55 23 * * *');
  }
}
