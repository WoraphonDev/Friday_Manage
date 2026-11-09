import { Global, Module } from '@nestjs/common';
import { Mailer } from './mail.js';

/** Mailer ตัวเดียวทั้งแอป (test อ่าน `sent` จากตัวนี้) */
@Global()
@Module({ providers: [Mailer], exports: [Mailer] })
export class MailModule {}
