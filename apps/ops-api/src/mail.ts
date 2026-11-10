import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** ไฟล์แนบ (เช่น CSV ให้สำนักงานบัญชี · B8) */
  attachments?: { filename: string; content: string; contentType: string }[];
}

/** ส่งอีเมลแจ้งลูกค้า (SMTP_HOST ไม่ตั้ง = log อย่างเดียว) · test แทน `transportFactory` ได้ */
@Injectable()
export class Mailer {
  private readonly log = new Logger('OpsMail');
  readonly sent: MailMessage[] = [];
  transportFactory = () =>
    nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });

  async send(m: MailMessage) {
    this.sent.push(m);
    if (!process.env.SMTP_HOST) {
      this.log.log(`[mail disabled] to=${m.to} subject=${m.subject}`);
      return;
    }
    await this.transportFactory().sendMail({ from: process.env.MAIL_FROM ?? 'Friday Manage <no-reply@localhost>', ...m });
  }
}
