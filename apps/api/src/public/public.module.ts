import { Module } from '@nestjs/common';
import { ContactSalesController, LegalAcceptancesController, PublicController } from './public.controller.js';
import { ContactSalesLimit, ContactSalesService } from './contact-sales.js';
import { PublicService } from './public.service.js';

/** หน้าสาธารณะ: แพ็กเกจและเอกสารกฎหมาย · งาน A30 (docs/tasks/A30-*.md) */
@Module({
  controllers: [PublicController, LegalAcceptancesController, ContactSalesController],
  providers: [PublicService, ContactSalesService, ContactSalesLimit],
})
export class PublicModule {}
