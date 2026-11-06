import { Module } from '@nestjs/common';
import { DueRequestsModule } from '../due-requests/due-requests.module.js';
import { HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

/** Home และ My Tasks · งาน A10 (docs/tasks/A10-*.md) */
@Module({
  imports: [DueRequestsModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
