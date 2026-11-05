import { Injectable, Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * ส่งอีเมล · ช่วงแรกปิดไว้ (docs/tech-stack.md) จึงแค่ log · งาน A24 (channels) ใส่ SMTP ของบริษัทที่ไฟล์นี้
 * เรียกจากที่ไหนก็ได้ที่ต้องส่งอีเมล (ยืนยันอีเมล, ลืมรหัสผ่าน, คำเชิญ)
 */
@Injectable()
export class Mailer {
  private readonly log = new Logger('Mailer');
  readonly enabled = false;

  async send(m: MailMessage): Promise<void> {
    this.log.log(`[mail disabled] to=${m.to} subject=${m.subject}`);
  }
}
