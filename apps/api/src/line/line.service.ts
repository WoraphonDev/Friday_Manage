import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { apiPublicUrl } from '../auth/auth.config.js';
import { hmacHex } from '../auth/crypto.js';
import { last4, openSecret, sealSecret } from '../channels/secrets.js';
import { AppError, forbidden } from '../common/errors.js';
import type { AuthInfo, TenantInfo } from '../common/request.js';
import { TenantDb } from '../common/tenant.js';
import { PlanLimits } from '../core/plan-limits.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { DueRequestsService } from '../due-requests/due-requests.service.js';
import { LineApi } from './line-api.js';

const s = schema;
const LINK_MINUTES = 10;
const MAX_BAD_CODES = 10;

export const PutLineBody = z.object({
  channelId: z.string().trim().min(1).max(40),
  /** ไม่ส่ง = ใช้ค่าเดิม (ตั้งครั้งแรกต้องส่ง) */
  channelSecret: z.string().trim().min(8).max(100).optional(),
  accessToken: z.string().trim().min(8).max(500).optional(),
  fallbackToEmail: z.boolean().default(true),
  batchDigestMinutes: z.number().int().min(1).max(60).default(5),
});
export const WorkspaceBody = z.object({ workspace: z.string().trim().min(1).max(63) });

/** ข้อมูลที่ปุ่ม postback พกไป (จำกัด 300 ตัวอักษรตาม LINE) */
export const postbackData = (requestId: string, decision: 'approve' | 'reject') => `a=due&id=${requestId}&d=${decision}`;

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
  webhookEventId?: string;
}

/** LINE OA: ตั้งค่า, ผูกบัญชี, กลุ่ม และปุ่มอนุมัติ/ปฏิเสธคำขอเลื่อน Due */
@Injectable()
export class LineService {
  private readonly log = new Logger('Line');
  /** กันเดารหัส 6 หลัก: นับครั้งที่ส่งรหัสผิดต่อบัญชี LINE ภายใน 10 นาที */
  private readonly badCodes = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly db: TenantDb,
    @Inject(SYSTEM_DB) private readonly system: Db,
    private readonly api: LineApi,
    private readonly due: DueRequestsService,
    private readonly limits: PlanLimits,
  ) {}

  private admin(tenant: TenantInfo) {
    if (tenant.role !== 'owner' && tenant.role !== 'admin') throw forbidden('ws.settings');
  }

  // ---------------------------------------------------------------------------
  // w/channels/line-oa
  // ---------------------------------------------------------------------------
  private configDto(tenant: TenantInfo, c: typeof s.lineOaConfigs.$inferSelect | undefined) {
    return {
      configured: !!c,
      // URL นี้นำไปใส่ใน LINE Developers Console › Messaging API › Webhook URL
      webhookUrl: `${apiPublicUrl()}/api/v1/hooks/line/${tenant.workspaceId}`,
      config: c ? { channelId: c.channelId, channelSecretLast4: c.channelSecretLast4, accessTokenLast4: c.accessTokenLast4, fallbackToEmail: c.fallbackToEmail, batchDigestMinutes: c.batchDigestMinutes } : null,
    };
  }

  async getConfig(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    const [c] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.lineOaConfigs));
    return this.configDto(tenant, c);
  }

  async putConfig(auth: AuthInfo, tenant: TenantInfo, body: z.infer<typeof PutLineBody>) {
    this.admin(tenant);
    await this.limits.assertFeature(tenant.workspaceId, 'channels');
    return this.db.run(auth, tenant, async (tx) => {
      const [old] = await tx.select().from(s.lineOaConfigs);
      if (!old && (!body.channelSecret || !body.accessToken)) {
        throw new AppError(400, 'invalid_input', 'ตั้งค่าครั้งแรกต้องส่ง channelSecret และ accessToken', { fields: [{ path: 'channelSecret', message: 'จำเป็น' }, { path: 'accessToken', message: 'จำเป็น' }] });
      }
      const values = {
        workspaceId: tenant.workspaceId,
        channelId: body.channelId,
        fallbackToEmail: body.fallbackToEmail,
        batchDigestMinutes: body.batchDigestMinutes,
        ...(body.channelSecret ? { channelSecretEncrypted: sealSecret(body.channelSecret), channelSecretLast4: last4(body.channelSecret) } : {}),
        ...(body.accessToken ? { accessTokenEncrypted: sealSecret(body.accessToken), accessTokenLast4: last4(body.accessToken) } : {}),
      };
      // แก้ค่าเดิมต้อง UPDATE (INSERT ... ON CONFLICT ต้องมีคอลัมน์ NOT NULL ครบแม้ไปทางอัปเดต)
      const [saved] = old
        ? await tx.update(s.lineOaConfigs).set(values).where(eq(s.lineOaConfigs.id, old.id)).returning()
        : await tx.insert(s.lineOaConfigs).values(values as typeof s.lineOaConfigs.$inferInsert).returning();
      await tx.insert(s.auditLogs).values({ workspaceId: tenant.workspaceId, actorId: auth.userId, actorKind: 'user', category: 'secu', action: 'channel.line_updated', targetType: 'channel', targetId: saved.id, summary: `LINE OA ${saved.channelId}` });
      return this.configDto(tenant, saved);
    });
  }

  /** ตรวจว่า access token ใช้ได้โดยถามข้อมูลบอทจาก LINE */
  async testConfig(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    const [c] = await this.db.run(auth, tenant, (tx) => tx.select().from(s.lineOaConfigs));
    if (!c) throw new AppError(409, 'line_not_configured', 'ยังไม่ได้ตั้งค่า LINE OA');
    try {
      const info = await this.api.botInfo(openSecret(c.accessTokenEncrypted));
      return { ok: true, botName: info.displayName ?? null, basicId: info.basicId ?? null };
    } catch (err) {
      throw new AppError(502, 'line_test_failed', 'เชื่อม LINE ไม่สำเร็จ · ตรวจ Channel access token', { reason: (err as Error).message.slice(0, 200) });
    }
  }

  async groups(auth: AuthInfo, tenant: TenantInfo) {
    this.admin(tenant);
    const rows = await this.db.run(auth, tenant, (tx) => tx.select().from(s.lineGroups).orderBy(asc(s.lineGroups.name)));
    return { items: rows.map((g) => ({ id: g.id, name: g.name, joinedAt: g.joinedAt })) };
  }

  // ---------------------------------------------------------------------------
  // me/line
  // ---------------------------------------------------------------------------
  async myStatus(auth: AuthInfo) {
    const [b] = await this.db.run(auth, null, (tx) => tx.select().from(s.lineBindings).where(eq(s.lineBindings.userId, auth.userId)));
    return { linked: !!b, displayName: b?.lineDisplayName ?? null, boundAt: b?.boundAt ?? null };
  }

  /** รหัส 6 หลัก 10 นาที · ผู้ใช้ส่งรหัสในแชตกับ OA ของ Workspace เพื่อผูกบัญชี */
  async createLinkCode(auth: AuthInfo) {
    return this.db.run(auth, null, async (tx) => {
      // รหัสเก่าที่ยังไม่ใช้ใช้ไม่ได้อีก
      await tx.delete(s.lineLinkCodes).where(and(eq(s.lineLinkCodes.userId, auth.userId), isNull(s.lineLinkCodes.usedAt)));
      for (let i = 0; i < 8; i++) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const expiresAt = new Date(Date.now() + LINK_MINUTES * 60_000);
        const [row] = await tx.insert(s.lineLinkCodes).values({ userId: auth.userId, codeHash: this.codeHash(code), expiresAt }).onConflictDoNothing().returning();
        if (row) return { code, expiresAt, expiresInSeconds: LINK_MINUTES * 60 };
      }
      throw new AppError(503, 'link_code_busy', 'สร้างรหัสไม่สำเร็จ ลองใหม่อีกครั้ง');
    });
  }

  private codeHash = (code: string) => hmacHex('line-link-code', code);

  async unlink(auth: AuthInfo) {
    const removed = await this.db.run(auth, null, (tx) => tx.delete(s.lineBindings).where(eq(s.lineBindings.userId, auth.userId)).returning({ id: s.lineBindings.id }));
    return { unlinked: removed.length > 0 };
  }

  /** ส่งข้อความทดสอบถึง LINE ของฉันผ่าน OA ของ Workspace ที่ระบุ */
  async testMine(auth: AuthInfo, workspaceSlug: string) {
    const tenant = await this.db.tenant(auth, workspaceSlug);
    const { config, binding } = await this.db.run(auth, tenant, async (tx) => ({
      config: (await tx.select().from(s.lineOaConfigs))[0],
      binding: (await tx.select().from(s.lineBindings).where(eq(s.lineBindings.userId, auth.userId)))[0],
    }));
    if (!config) throw new AppError(409, 'line_not_configured', 'Workspace นี้ยังไม่ได้ตั้งค่า LINE OA');
    if (!binding) throw new AppError(409, 'line_not_linked', 'ยังไม่ได้ผูกบัญชี LINE');
    try {
      await this.api.push(openSecret(config.accessTokenEncrypted), binding.lineUserId, [{ type: 'text', text: 'ทดสอบการแจ้งเตือนจาก Friday Manage ✅' }]);
    } catch (err) {
      throw new AppError(502, 'line_push_failed', 'ส่งข้อความไป LINE ไม่สำเร็จ', { reason: (err as Error).message.slice(0, 200) });
    }
    return { sent: true };
  }

  // ---------------------------------------------------------------------------
  // POST hooks/line/:workspaceId
  // ---------------------------------------------------------------------------
  /** ตรวจลายเซ็น (base64 HMAC-SHA256 ของ body ด้วย Channel secret) แล้วประมวลผลทีละ event · ลายเซ็นถูกแล้วตอบ 200 เสมอ */
  async handleWebhook(workspaceId: string, raw: Buffer, signature: string | undefined) {
    if (!z.uuid().safeParse(workspaceId).success) throw new AppError(404, 'not_found', 'ไม่พบ');
    // SYSTEM_DB เพราะผู้เรียกคือ LINE (ไม่มี session / Workspace context)
    const [config] = await this.system.select().from(s.lineOaConfigs).where(eq(s.lineOaConfigs.workspaceId, workspaceId));
    if (!config) throw new AppError(404, 'not_found', 'ไม่พบ');
    const secret = openSecret(config.channelSecretEncrypted);
    const expected = createHmac('sha256', secret).update(raw).digest();
    const given = Buffer.from(signature ?? '', 'base64');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AppError(401, 'invalid_signature', 'ลายเซ็นไม่ถูกต้อง');

    let body: { events?: LineEvent[] };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'invalid_json', 'ข้อมูลไม่ใช่ JSON');
    }
    const token = openSecret(config.accessTokenEncrypted);
    for (const ev of body.events ?? []) {
      try {
        await this.event(workspaceId, token, ev);
      } catch (err) {
        this.log.error(`event ${ev.type} ${ev.webhookEventId ?? ''} failed: ${(err as Error).stack ?? err}`);
      }
    }
    return { ok: true };
  }

  private async reply(token: string, ev: LineEvent, text: string) {
    if (!ev.replyToken) return;
    await this.api.reply(token, ev.replyToken, [{ type: 'text', text }]).catch((err) => this.log.warn(`reply failed: ${err.message}`));
  }

  private async event(workspaceId: string, token: string, ev: LineEvent) {
    const src = ev.source ?? {};
    if (ev.type === 'join' && (src.groupId || src.roomId)) {
      const lineGroupId = (src.groupId ?? src.roomId)!;
      const name = src.groupId ? ((await this.api.groupSummary(token, lineGroupId).catch(() => null))?.groupName ?? 'LINE กลุ่ม') : 'LINE ห้องสนทนา';
      await this.system.insert(s.lineGroups).values({ workspaceId, lineGroupId, name }).onConflictDoUpdate({ target: [s.lineGroups.workspaceId, s.lineGroups.lineGroupId], set: { name } });
      return;
    }
    if (ev.type === 'leave' && (src.groupId || src.roomId)) {
      await this.system.delete(s.lineGroups).where(and(eq(s.lineGroups.workspaceId, workspaceId), eq(s.lineGroups.lineGroupId, (src.groupId ?? src.roomId)!)));
      return;
    }
    if (ev.type === 'follow') {
      await this.reply(token, ev, 'ยินดีต้อนรับสู่ Friday Manage 👋\nไปที่ Profile › การแจ้งเตือน เพื่อรับรหัส 6 หลัก แล้วพิมพ์ส่งในแชตนี้เพื่อผูกบัญชี');
      return;
    }
    if (ev.type === 'message' && ev.message?.type === 'text' && src.type === 'user' && src.userId) {
      const text = (ev.message.text ?? '').trim();
      if (/^\d{6}$/.test(text)) await this.link(workspaceId, token, ev, src.userId, text);
      return;
    }
    if (ev.type === 'postback' && src.userId && ev.postback?.data) await this.postback(workspaceId, token, ev, src.userId, ev.postback.data);
  }

  private async link(workspaceId: string, token: string, ev: LineEvent, lineUserId: string, code: string) {
    const now = Date.now();
    const bad = this.badCodes.get(lineUserId);
    if (bad && bad.until > now && bad.n >= MAX_BAD_CODES) return; // เงียบ ไม่ให้เดาต่อ
    const [row] = await this.system.select().from(s.lineLinkCodes).where(and(eq(s.lineLinkCodes.codeHash, this.codeHash(code)), isNull(s.lineLinkCodes.usedAt), gt(s.lineLinkCodes.expiresAt, new Date())));
    const member = row
      ? (await this.system.select({ id: s.workspaceMembers.userId }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.userId, row.userId), eq(s.workspaceMembers.status, 'active'))))[0]
      : undefined;
    if (!row || !member) {
      this.badCodes.set(lineUserId, { n: (bad && bad.until > now ? bad.n : 0) + 1, until: now + LINK_MINUTES * 60_000 });
      return this.reply(token, ev, 'รหัสไม่ถูกต้องหรือหมดอายุ กรุณาขอรหัสใหม่ที่ Profile › การแจ้งเตือน');
    }
    const [mine] = await this.system.select().from(s.lineBindings).where(eq(s.lineBindings.userId, row.userId));
    const [taken] = await this.system.select().from(s.lineBindings).where(eq(s.lineBindings.lineUserId, lineUserId));
    if (mine || taken) return this.reply(token, ev, mine ? 'บัญชี Friday Manage นี้ผูก LINE ไว้แล้ว · ยกเลิกการผูกที่ Profile ก่อนจึงจะผูกใหม่ได้' : 'บัญชี LINE นี้ผูกกับผู้ใช้อื่นอยู่แล้ว');
    const name = (await this.api.profile(token, lineUserId).catch(() => null))?.displayName ?? null;
    await this.system.transaction(async (tx) => {
      await tx.insert(s.lineBindings).values({ userId: row.userId, lineUserId, lineDisplayName: name });
      await tx.update(s.lineLinkCodes).set({ usedAt: new Date() }).where(eq(s.lineLinkCodes.id, row.id));
      await tx.insert(s.auditLogs).values({ workspaceId, actorId: row.userId, actorKind: 'user', category: 'secu', action: 'line.linked', targetType: 'user', targetId: row.userId, summary: `ผูกบัญชี LINE ${name ?? ''}`.trim() });
    });
    this.badCodes.delete(lineUserId);
    await this.reply(token, ev, `ผูกบัญชีสำเร็จ ✅${name ? `\nสวัสดี ${name}` : ''}\nจากนี้คุณจะได้รับแจ้งเตือนตามที่ตั้งไว้ใน Profile`);
  }

  /** ปุ่มอนุมัติ / ปฏิเสธใน LINE · ตรวจว่าบัญชี LINE ผูกกับผู้ใช้ที่เป็นสมาชิก Workspace นี้ แล้วให้ DueRequestsService ตรวจสิทธิ์อนุมัติ · Audit ทุกครั้ง */
  private async postback(workspaceId: string, token: string, ev: LineEvent, lineUserId: string, data: string) {
    const p = new URLSearchParams(data);
    const id = p.get('id') ?? '';
    const decision = p.get('d');
    if (p.get('a') !== 'due' || (decision !== 'approve' && decision !== 'reject') || !z.uuid().safeParse(id).success) return;
    const audit = (actorId: string | null, result: string) =>
      this.system.insert(s.auditLogs).values({ workspaceId, actorId, actorKind: actorId ? 'user' : 'system', category: 'perm', action: 'due_request.line_postback', targetType: 'due_request', targetId: id, summary: `${decision} ผ่าน LINE · ${result}` });

    const [binding] = await this.system.select().from(s.lineBindings).where(eq(s.lineBindings.lineUserId, lineUserId));
    if (!binding) {
      await audit(null, 'ปฏิเสธ: บัญชี LINE ยังไม่ได้ผูก');
      return this.reply(token, ev, 'บัญชี LINE นี้ยังไม่ได้ผูกกับ Friday Manage จึงอนุมัติไม่ได้');
    }
    const [m] = await this.system
      .select({ slug: s.workspaces.slug, role: s.workspaceMembers.role })
      .from(s.workspaceMembers)
      .innerJoin(s.workspaces, eq(s.workspaces.id, s.workspaceMembers.workspaceId))
      .where(and(eq(s.workspaceMembers.workspaceId, workspaceId), eq(s.workspaceMembers.userId, binding.userId), eq(s.workspaceMembers.status, 'active')));
    if (!m) {
      await audit(binding.userId, 'ปฏิเสธ: ไม่ใช่สมาชิก Workspace');
      return this.reply(token, ev, 'คุณไม่ได้เป็นสมาชิกของ Workspace นี้');
    }
    const auth: AuthInfo = { userId: binding.userId, sessionId: 'line' };
    const tenant: TenantInfo = { workspaceId, slug: m.slug, role: m.role };
    try {
      const r = await this.due.decide(auth, tenant, id, decision, undefined, 'line');
      await audit(binding.userId, 'สำเร็จ');
      await this.reply(token, ev, `${decision === 'approve' ? 'อนุมัติ' : 'ปฏิเสธ'}คำขอเลื่อน Due ${r.issue?.key ?? ''} เรียบร้อย`.replace('  ', ' '));
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      const msg = !e ? 'ระบบขัดข้อง ลองใหม่ในแอป' : e.getStatus() === 403 ? 'คุณไม่มีสิทธิ์อนุมัติคำขอนี้' : e.code === 'already_decided' ? 'คำขอนี้ถูกตัดสินไปแล้ว' : e.getStatus() === 404 ? 'ไม่พบคำขอนี้' : e.message;
      await audit(binding.userId, `ไม่สำเร็จ: ${e?.code ?? 'error'}`);
      await this.reply(token, ev, msg);
    }
  }
}
