import { Body, Controller, Get, HttpCode, Module, Param, Post, Query } from '@nestjs/common';
import { Auth, type AuthInfo } from '../common/request.js';
import { parse } from '../common/validate.js';
import { Audience } from './audience.js';
import { AnswerBody, DismissBody, NpsService, PromptQuery } from './nps.service.js';
import { SeenBody, WhatsNewService, WorkspaceQuery } from './whats-new.service.js';

/**
 * มีอะไรใหม่ (U1) และ Spotlight (U2) · route ระดับผู้ใช้ที่รับ `?workspace=slug` (กรองตามแพ็กเกจ / flag / บทบาทของ Workspace นั้น)
 * รายการเขียนโดยทีม Friday ใน Friday Ops (O33)
 */
@Controller('me')
export class WhatsNewController {
  constructor(private readonly whatsNew: WhatsNewService) {}

  /** รายการ 90 วันล่าสุดที่ผู้ใช้เห็นได้ + จำนวนที่ยังไม่เห็น (จุดเหลืองบนแถบบน) */
  @Get('whats-new')
  list(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.whatsNew.list(auth, parse(WorkspaceQuery, query).workspace);
  }

  /** เปิดแผงแล้ว: บันทึกเวลาที่เห็นและเพิ่มยอดเห็นของรายการใหม่ */
  @Post('whats-new/seen')
  @HttpCode(200)
  seen(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.whatsNew.seen(auth, parse(SeenBody, body).workspace);
  }

  /** กดปุ่ม "ลองใช้" ของรายการ (นับคลิก ไม่เก็บว่าใครกด) */
  @Post('whats-new/:id/click')
  @HttpCode(200)
  click(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.whatsNew.click(auth, id);
  }

  /** Spotlight ที่ยังไม่เห็น (ไม่เกิน 1 รายการ) */
  @Get('spotlight')
  spotlight(@Auth() auth: AuthInfo, @Query() query: unknown) {
    return this.whatsNew.spotlight(auth, parse(WorkspaceQuery, query).workspace);
  }

  /** ปิด Spotlight แล้วไม่แสดงอีก */
  @Post('spotlight/:id/dismiss')
  @HttpCode(200)
  dismissSpotlight(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.whatsNew.dismissSpotlight(auth, id);
  }
}

/** แบบสำรวจ NPS ในแอป (U3) · ตั้งค่าโดยทีม Friday (O33 › U5) */
@Controller('me')
export class NpsController {
  constructor(private readonly nps: NpsService) {}

  /** ถามตอนนี้ไหม (ถาม = บันทึกว่าแสดงแล้ววันนี้) */
  @Get('nps-prompt')
  prompt(@Auth() auth: AuthInfo, @Query() query: unknown) {
    const q = parse(PromptQuery, query);
    return this.nps.prompt(auth, q.workspace, { mobile: q.mobile === 'true', sessionSeconds: q.sessionSeconds });
  }

  /** ส่งคะแนน 0–10 พร้อมความเห็น / หัวข้อ (ไม่บังคับ) */
  @Post('nps')
  @HttpCode(201)
  answer(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.nps.answer(auth, parse(AnswerBody, body));
  }

  /** ปิดโดยไม่ตอบ (ไม่ถามจนถึงรอบถัดไป) */
  @Post('nps/dismiss')
  @HttpCode(200)
  dismiss(@Auth() auth: AuthInfo, @Body() body: unknown) {
    return this.nps.dismiss(auth, parse(DismissBody, body));
  }
}

@Module({ controllers: [WhatsNewController, NpsController], providers: [Audience, WhatsNewService, NpsService] })
export class ChangelogModule {}
