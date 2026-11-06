import { Module } from '@nestjs/common';
import { LegalAcceptancesController, PublicController } from './public.controller.js';
import { PublicService } from './public.service.js';

/** หน้าสาธารณะ: แพ็กเกจและเอกสารกฎหมาย · งาน A30 (docs/tasks/A30-*.md) */
@Module({
  controllers: [PublicController, LegalAcceptancesController],
  providers: [PublicService],
})
export class PublicModule {}
