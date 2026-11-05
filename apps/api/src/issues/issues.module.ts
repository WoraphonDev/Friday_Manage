import { Module } from '@nestjs/common';
import { IssuesController } from './issues.controller.js';

/** งาน (IssuesService อยู่ใน CoreModule) · งาน: A03 */
@Module({
  controllers: [IssuesController],
  providers: [],
})
export class IssuesModule {}
