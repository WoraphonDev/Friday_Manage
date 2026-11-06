import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

/** แพ็กเกจและการชำระเงิน · งาน A29 (docs/tasks/A29-*.md) · การชำระเงินจริงอยู่ที่ A33 */
@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
