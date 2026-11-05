import { Module } from '@nestjs/common';
import { IssuePartsController } from './issue-parts.controller.js';
import { IssuePartsService } from './issue-parts.service.js';

@Module({
  controllers: [IssuePartsController],
  providers: [IssuePartsService],
})
export class IssuePartsModule {}
