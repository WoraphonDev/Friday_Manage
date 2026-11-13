import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** ชื่อผู้ส่งที่แสดง (`ชื่อ <อีเมล>`) · ไม่ส่ง = MAIL_FROM */
  from?: string;
  replyTo?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string | null;
  pass?: string | null;
  secure?: boolean;
}

type Transport = { sendMail(m: Record<string, unknown>): Promise<unknown> };

/**
 * ส่งอีเมลผ่าน SMTP (nodemailer) · เรียกจากที่ไหนก็ได้ที่ต้องส่งอีเมล (ยืนยันอีเมล, ลืมรหัสผ่าน, คำเชิญ, ช่องทางแจ้งเตือน)
 * - ค่าของระบบจาก env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, MAIL_FROM
 * - Workspace ที่ตั้ง SMTP ของตัวเอง (email_sender_config) ส่งค่าเข้า `smtp` ตอนเรียก
 * - ไม่มีทั้งสองอย่าง = ปิดอยู่ (docs/tech-stack.md) · แค่ log ไม่ส่ง ไม่ throw
 * ส่งไม่สำเร็จ throw ให้ผู้เรียกตัดสินใจ (คิวแจ้งเตือนใช้ retry)
 */
@Injectable()
export class Mailer {
  private readonly log = new Logger('Mailer');

  /** test แทนที่ได้เพื่อไม่ต้องมี SMTP จริง */
  transportFactory: (cfg: SmtpConfig) => Transport = (cfg) =>
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? cfg.port === 465,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });

  /** SMTP ของระบบจาก env (null = ปิด) */
  get system(): SmtpConfig | null {
    const host = process.env.SMTP_HOST;
    if (!host) return null;
    return {
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER || null,
      pass: process.env.SMTP_PASS || null,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : undefined,
    };
  }

  get enabled() {
    return this.system !== null;
  }

  async send(m: MailMessage, smtp?: SmtpConfig): Promise<void> {
    const cfg = smtp ?? this.system;
    if (!cfg) {
      this.log.log(`[mail disabled] to=${m.to} subject=${m.subject}`);
      return;
    }
    await this.transportFactory(cfg).sendMail({
      from: m.from ?? process.env.MAIL_FROM ?? 'Friday Work Management <no-reply@localhost>',
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      replyTo: m.replyTo,
    });
  }
}
