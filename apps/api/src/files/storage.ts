import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { apiPublicUrl } from '../auth/auth.config.js';
import { signToken, verifyToken } from '../auth/crypto.js';
import { config } from '../config.js';

export const UPLOAD_TTL_SECONDS = 15 * 60;
/** ลิงก์ดาวน์โหลดหมดอายุใน 5 นาที (03-api 3.8) */
export const DOWNLOAD_TTL_SECONDS = 5 * 60;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
}

export interface StorageDriver {
  readonly kind: 'local' | 's3';
  presignUpload(key: string, o: { size: number; mime: string }): Promise<UploadTarget>;
  stat(key: string): Promise<{ size: number } | null>;
  presignDownload(key: string, o: { filename: string; mime: string }): Promise<string>;
}

const disposition = (filename: string) => `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;

/** ที่เก็บในเครื่อง (dev / test / Codex) · ใช้ลิงก์ที่ลงลายมือชื่อไปที่ API เอง (StorageController) */
@Injectable()
export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  readonly root = resolve(config.uploadDir, 'files');

  /** กัน path traversal: ทุก key ต้องอยู่ใต้ root */
  path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  async presignUpload(key: string, o: { size: number; mime: string }): Promise<UploadTarget> {
    const token = signToken('storage-put', { k: key, s: o.size }, UPLOAD_TTL_SECONDS);
    return { method: 'PUT', url: `${apiPublicUrl()}/api/v1/storage/upload/${token}`, headers: { 'content-type': 'application/octet-stream' } };
  }

  async stat(key: string) {
    try {
      const st = await stat(this.path(key));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }

  async presignDownload(key: string, o: { filename: string; mime: string }) {
    const token = signToken('storage-get', { k: key, n: o.filename, m: o.mime }, DOWNLOAD_TTL_SECONDS);
    return `${apiPublicUrl()}/api/v1/storage/download/${token}`;
  }

  /** เขียน body ที่รับมาลงไฟล์ · เกินขนาดที่ประกาศไว้ = ทิ้งและแจ้ง */
  async write(key: string, body: NodeJS.ReadableStream, expected: number) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.part`;
    let bytes = 0;
    const out = createWriteStream(tmp);
    const overflow = new Error('too_large');
    try {
      await new Promise<void>((ok, fail) => {
        body.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > expected) {
            out.destroy();
            fail(overflow);
          }
        });
        body.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => ok());
        body.pipe(out);
      });
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    if (bytes !== expected) {
      await rm(tmp, { force: true });
      throw new Error('size_mismatch');
    }
    await rename(tmp, path);
  }

  read(key: string) {
    return createReadStream(this.path(key));
  }

  verify(purpose: 'storage-put' | 'storage-get', token: string) {
    return verifyToken<Record<string, unknown> & { k: string }>(purpose, token);
  }
}

/** S3 (หรือที่เข้ากันได้ เช่น MinIO) · เปิดใช้เมื่อตั้ง S3_BUCKET · เซิร์ฟเวอร์ไม่แตะตัวไฟล์ ใช้ presigned URL ล้วน */
@Injectable()
export class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private client: S3Client | null = null;

  private get bucket() {
    return process.env.S3_BUCKET!;
  }

  private get s3() {
    this.client ??= new S3Client({ region: process.env.S3_REGION ?? 'ap-southeast-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT });
    return this.client;
  }

  async presignUpload(key: string, o: { size: number; mime: string }): Promise<UploadTarget> {
    // ผูก Content-Length และ Content-Type ไว้ใน signature จึงอัปโหลดไฟล์ขนาดอื่นไม่ได้
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: o.mime, ContentLength: o.size }), { expiresIn: UPLOAD_TTL_SECONDS });
    return { method: 'PUT', url, headers: { 'content-type': o.mime } };
  }

  async stat(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  presignDownload(key: string, o: { filename: string; mime: string }) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition(o.filename), ResponseContentType: o.mime }), { expiresIn: DOWNLOAD_TTL_SECONDS });
  }
}

export const contentDisposition = disposition;
