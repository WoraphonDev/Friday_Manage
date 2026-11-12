import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AnnouncementsModule } from '../announcements/announcements.module.js';
import { type OpsRequest, Reauth, Roles } from '../auth/auth.guard.js';
import { AppError, parse } from '../errors.js';
import { CouponBody, CouponPatch, DisableBody, PlanBody, PromotionsService } from './promotions.service.js';

/** มีคำขออนุมัติ → 202 · ไม่มี → สถานะปกติของคำขอ (200 / 201) */
async function respond<T extends object>(res: Response, p: Promise<T>, ok = 200) {
  const r = await p;
  res.status('pendingApproval' in r && r.pendingApproval ? 202 : ok);
  return r;
}

/** แพ็กเกจและโปรโมชัน (O20) · Owner และการเงิน · แก้ราคาและเปิดคูปองต้องแตะ Security key (G4) */
@Controller('ops/promotions')
export class PromotionsController {
  constructor(private readonly promo: PromotionsService) {}

  @Roles('owner', 'finance')
  @Get()
  overview() {
    return this.promo.overview();
  }

  @Roles('owner', 'finance')
  @Get('price-history')
  history() {
    return this.promo.priceHistory();
  }

  /** P1 · บันทึกเป็นเวอร์ชันใหม่ · เปลี่ยนราคาต้องมีคนอนุมัติเสมอ */
  @Roles('owner', 'finance')
  @Reauth()
  @Post('plans/:code')
  updatePlan(@Req() req: OpsRequest, @Param('code') code: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.promo.updatePlan(req.staff!, code, parse(PlanBody, body)));
  }

  @Roles('owner', 'finance')
  @Post('coupons')
  createCoupon(@Req() req: OpsRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(CouponBody, body);
    // ตรวจก่อนบันทึก: หน้าเว็บส่งคำขอเดิมซ้ำหลังแตะ key ถ้าบันทึกร่างไปก่อนจะชนโค้ดซ้ำ
    if (input.activate && !req.reauthed) throw new AppError(401, 'reauth_required', 'แตะ Security key เพื่อยืนยันตัวตนอีกครั้ง');
    return respond(res, this.promo.createCoupon(req.staff!, input), 201);
  }

  @Roles('owner', 'finance')
  @Patch('coupons/:id')
  updateCoupon(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.promo.updateCoupon(req.staff!, id, parse(CouponPatch, body));
  }

  @Roles('owner', 'finance')
  @Reauth()
  @Post('coupons/:id/activate')
  activate(@Req() req: OpsRequest, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return respond(res, this.promo.activate(req.staff!, id));
  }

  /** ปิดก่อนกำหนด · คนที่ใช้แล้วยังได้ส่วนลดครบรอบ */
  @Roles('owner', 'finance')
  @Post('coupons/:id/disable')
  @HttpCode(200)
  disable(@Req() req: OpsRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.promo.disable(req.staff!, id, parse(DisableBody, body));
  }

  @Roles('owner', 'finance')
  @Get('coupons/:id/redemptions')
  redemptions(@Param('id') id: string) {
    return this.promo.redemptions(id);
  }
}

@Module({ imports: [AnnouncementsModule], controllers: [PromotionsController], providers: [PromotionsService] })
export class PromotionsModule {}
