import { Module } from '@nestjs/common';
import { CommentsService } from '../comments/comments.service.js';
import { AutomationController } from './automation.controller.js';
import { AutomationService } from './automation.service.js';
import { AutomationEngine } from './engine.js';

/** Automation · งาน A26 (docs/tasks/A26-automation.md) · CommentsService สร้างอินสแตนซ์ของ module นี้เองเพราะ CommentsModule ไม่ export */
@Module({
  controllers: [AutomationController],
  providers: [AutomationService, AutomationEngine, CommentsService],
  exports: [AutomationEngine],
})
export class AutomationModule {}
