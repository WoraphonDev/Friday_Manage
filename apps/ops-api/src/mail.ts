import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** อีเมลที่ต้องมีปุ่ม (เช่น คำเชิญที่ส่งซ้ำจากสคริปต์ O56) · ไม่ใส่ = ข้อความล้วน */
  html?: string;
  /** ผู้รับตอบกลับหาคนที่เกี่ยวข้อง (เช่น ผู้เชิญ) แทนระบบ */
  replyTo?: string;
  /** ไฟล์แนบ (เช่น CSV ให้สำนักงานบัญชี · B8) */
  attachments?: { filename: string; content: string | Buffer; contentType: string }[];
}

/** ส่งอีเมลแจ้งลูกค้า (SMTP_HOST ไม่ตั้ง = log อย่างเดียว) · test แทน `transportFactory` ได้ */
@Injectable()
export class Mailer {
  private readonly log = new Logger('OpsMail');
  readonly sent: MailMessage[] = [];
  transportFactory = () =>
    nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });

  /** ตั้ง SMTP แล้ว (ไม่ตั้ง = send แค่ log ไม่มีอีเมลออกจริง) */
  get enabled() {
    return !!process.env.SMTP_HOST;
  }

  async send(m: MailMessage) {
    this.sent.push(m);
    if (!process.env.SMTP_HOST) {
      this.log.log(`[mail disabled] to=${m.to} subject=${m.subject}`);
      return;
    }
    await this.transportFactory().sendMail({ from: process.env.MAIL_FROM ?? 'Friday Work Management <no-reply@localhost>', ...m });
  }
}
