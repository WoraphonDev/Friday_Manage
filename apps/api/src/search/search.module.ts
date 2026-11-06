import { Module } from '@nestjs/common';
import { SavedService } from './saved.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** ค้นหา, การค้นหาที่บันทึก และ View ที่บันทึก · งาน A22 (docs/tasks/A22-*.md) */
@Module({
  controllers: [SearchController],
  providers: [SearchService, SavedService],
})
export class SearchModule {}
