import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { InvoicesService } from './invoices.service.js';
import { PaymentHooksController, PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { ETAX_PROVIDER, etaxFromEnv, PAYMENT_GATEWAY, gatewayFromEnv } from './providers.js';

/** ชำระเงินและใบกำกับภาษี · งาน A33 (docs/tasks/A33-payments.md) · Stripe และ e-Tax เป็น provider ที่สลับได้ (ตัวปลอมเมื่อไม่ตั้ง env) */
@Module({
  imports: [BillingModule],
  controllers: [PaymentsController, PaymentHooksController],
  providers: [
    PaymentsService,
    InvoicesService,
    { provide: PAYMENT_GATEWAY, useFactory: () => gatewayFromEnv() },
    { provide: ETAX_PROVIDER, useFactory: () => etaxFromEnv() },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
