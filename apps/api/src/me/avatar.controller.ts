import { randomBytes } from 'node:crypto';
import { Controller, Delete, Get, HttpCode, Inject, Param, Put, Req, Res } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../common/errors.js';
import { Auth, type AuthInfo, Public } from '../common/request.js';
import { SYSTEM_DB } from '../db/db.module.js';

const s = schema;
/** หน้าเว็บย่อเป็น 256×256 ก่อนส่ง (ราว 20–60 KB) · เผื่อไว้สำหรับรูปที่ย่อไม่ได้ */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** ตรวจจากหัวไฟล์ ไม่เชื่อ Content-Type อย่างเดียว (กันส่ง HTML / SVG มาแสดงในชื่อรูป) */
function sniff(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_AVATAR_BYTES) throw new AppError(413, 'file_too_large', 'รูปใหญ่เกิน 512 KB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const avatarPath = (userId: string, version: string) => `/api/v1/avatars/${userId}/${version}`;

/**
 * รูปโปรไฟล์ที่อัปโหลดเอง (หน้า I) · ส่งไฟล์รูปตรง ๆ เป็น body (image/png · jpeg · webp)
 * users และ user_avatars ไม่มี policy ให้ friday_app แก้ users ของตัวเอง จึงเขียนด้วย SYSTEM_DB โดยล็อก id ของผู้เรียก (เหมือน patchMe)
 */
@Controller('me/avatar')
export class MyAvatarController {
  constructor(@Inject(SYSTEM_DB) private readonly system: Db) {}

  @Put()
  @HttpCode(200)
  async upload(@Auth() auth: AuthInfo, @Req() req: Request) {
    const data = await readBody(req);
    const mime = sniff(data);
    if (!mime) throw new AppError(415, 'unsupported_image', 'รองรับเฉพาะรูป PNG, JPEG หรือ WebP');
    // version ใหม่ทุกครั้ง: URL เปลี่ยน จึงให้เบราว์เซอร์ cache ได้ถาวร
    const version = randomBytes(9).toString('base64url');
    const avatarUrl = avatarPath(auth.userId, version);
    await this.system.transaction(async (tx) => {
      await tx
        .insert(s.userAvatars)
        .values({ userId: auth.userId, mime, data, version })
        .onConflictDoUpdate({ target: s.userAvatars.userId, set: { mime, data, version, updatedAt: new Date() } });
      await tx.update(s.users).set({ avatarUrl }).where(eq(s.users.id, auth.userId));
    });
    return { avatarUrl };
  }

  @Delete()
  @HttpCode(200)
  async remove(@Auth() auth: AuthInfo) {
    await this.system.transaction(async (tx) => {
      await tx.delete(s.userAvatars).where(eq(s.userAvatars.userId, auth.userId));
      await tx.update(s.users).set({ avatarUrl: null }).where(eq(s.users.id, auth.userId));
    });
    return { avatarUrl: null };
  }
}

/**
 * แสดงรูปโปรไฟล์ · Public เพราะ <img> ในอีเมล / หน้าที่ยังไม่ล็อกอินก็ต้องเห็น และ URL มี version สุ่มที่เดาไม่ได้
 * อ่านด้วย SYSTEM_DB เพราะเพื่อนร่วมทีม (และ <img> ที่ไม่ส่ง context ของ Workspace) ต้องเห็นรูปของคนอื่น
 */
@Controller('avatars')
export class AvatarsController {
  constructor(@Inject(SYSTEM_DB) private readonly system: Db) {}

  @Public()
  @Get(':userId/:version')
  async show(@Param('userId') userId: string, @Param('version') version: string, @Res() res: Response) {
    if (!z.uuid().safeParse(userId).success || !/^[\w-]{6,40}$/.test(version)) throw notFound('รูปโปรไฟล์');
    const [row] = await this.system
      .select({ mime: s.userAvatars.mime, data: s.userAvatars.data })
      .from(s.userAvatars)
      .where(and(eq(s.userAvatars.userId, userId), eq(s.userAvatars.version, version)));
    if (!row) throw notFound('รูปโปรไฟล์');
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(row.data);
  }
}
