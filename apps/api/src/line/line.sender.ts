import { Inject, Injectable } from '@nestjs/common';
import { type Db, schema } from '@friday/db';
import { and, eq } from 'drizzle-orm';
import { UnrecoverableError } from '../queue/jobs.js';
import { openSecret } from '../channels/secrets.js';
import type { ChannelSender, ExternalChannel, SendContext } from '../channels/senders.js';
import type { Msg } from '../channels/message.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { LineApi, type LineMessage } from './line-api.js';
import { postbackData } from './line.service.js';

const s = schema;

const text = (m: Msg) =>
  [m.head, m.title, m.project, ...m.rows.map(([k, v]) => `${k}: ${v}`), m.note ? `“${m.note}”` : '', m.url].filter(Boolean).join('\n');

/** ข้อความ Flex พร้อมปุ่มอนุมัติ / ปฏิเสธ (ทำงานใน LINE ได้ทันที) */
function approvalFlex(m: Msg, requestId: string): LineMessage {
  const row = ([k, v]: [string, string]) => ({ type: 'box', layout: 'baseline', contents: [{ type: 'text', text: k, size: 'sm', color: '#5F6873', flex: 3 }, { type: 'text', text: v, size: 'sm', wrap: true, flex: 5 }] });
  return {
    type: 'flex',
    altText: `${m.head}: ${m.title}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: m.color, contents: [{ type: 'text', text: m.head, color: '#FFFFFF', weight: 'bold', wrap: true }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'text', text: m.title, weight: 'bold', wrap: true }, { type: 'text', text: m.project, size: 'xs', color: '#5F6873', wrap: true }, ...m.rows.map(row), { type: 'text', text: 'รายละเอียดดูได้ในแอปหลังเข้าสู่ระบบ', size: 'xs', color: '#5F6873', wrap: true }] },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#15803D', action: { type: 'postback', label: 'อนุมัติ', data: postbackData(requestId, 'approve'), displayText: 'อนุมัติ' } },
          { type: 'button', style: 'primary', color: '#B91C1C', action: { type: 'postback', label: 'ปฏิเสธ', data: postbackData(requestId, 'reject'), displayText: 'ปฏิเสธ' } },
          { type: 'button', style: 'link', action: { type: 'uri', label: 'เปิดในแอป', uri: m.url } },
        ],
      },
    },
  };
}

abstract class LineSenderBase {
  constructor(
    protected readonly db: Db,
    protected readonly api: LineApi,
  ) {}

  protected async token(workspaceId: string) {
    const [c] = await this.db.select().from(s.lineOaConfigs).where(eq(s.lineOaConfigs.workspaceId, workspaceId));
    if (!c) throw new UnrecoverableError('Workspace นี้ยังไม่ได้ตั้งค่า LINE OA');
    return openSecret(c.accessTokenEncrypted);
  }

  async available(workspaceId: string) {
    const [c] = await this.db.select({ id: s.lineOaConfigs.id }).from(s.lineOaConfigs).where(eq(s.lineOaConfigs.workspaceId, workspaceId));
    return !!c;
  }

  /** ปุ่มอนุมัติ/ปฏิเสธต้องรู้ id คำขอ: ข้อความที่ส่งมามีแค่ Issue key ใน title จึงหาคำขอที่ยังรออยู่ของงานนั้น */
  protected async messagesFor(ctx: SendContext): Promise<LineMessage[]> {
    if (ctx.msg.event === 'due_request.created') {
      const m = ctx.msg.title.match(/^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)/);
      if (m) {
        const [r] = await this.db
          .select({ id: s.dueChangeRequests.id })
          .from(s.dueChangeRequests)
          .innerJoin(s.issues, eq(s.issues.id, s.dueChangeRequests.issueId))
          .innerJoin(s.projects, eq(s.projects.id, s.issues.projectId))
          .where(and(eq(s.dueChangeRequests.workspaceId, ctx.workspaceId), eq(s.projects.key, m[1]!.toUpperCase()), eq(s.issues.number, Number(m[2])), eq(s.dueChangeRequests.status, 'pending')));
        if (r) return [approvalFlex(ctx.msg, r.id)];
      }
    }
    return [{ type: 'text', text: text(ctx.msg) }];
  }

  /** 4xx (ถูกบล็อก, token ผิด) ลองใหม่ไม่ช่วย · 429 / 5xx ลองใหม่ได้ */
  protected async push(token: string, to: string, messages: LineMessage[]) {
    try {
      await this.api.push(token, to, messages);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
  }
}

/** LINE ส่วนตัว: ตาม pref ของผู้รับ (ผู้รับต้องผูกบัญชีแล้ว) */
@Injectable()
export class LinePersonalSender extends LineSenderBase implements ChannelSender {
  readonly channel: ExternalChannel = 'line';
  readonly scope = 'personal' as const;

  constructor(@Inject(SYSTEM_DB) db: Db, api: LineApi) {
    super(db, api);
  }

  async targetFor(recipientId: string) {
    const [b] = await this.db.select({ id: s.lineBindings.lineUserId }).from(s.lineBindings).where(eq(s.lineBindings.userId, recipientId));
    return b?.id ?? null;
  }

  async send(ctx: SendContext) {
    await this.push(await this.token(ctx.workspaceId), ctx.targetRef, await this.messagesFor(ctx));
  }
}

/** LINE กลุ่ม: ตามกฎแจ้งเตือนของโปรเจกต์ · targetRef = id แถวใน line_groups */
@Injectable()
export class LineGroupSender extends LineSenderBase implements ChannelSender {
  readonly channel: ExternalChannel = 'line_group';
  readonly scope = 'project' as const;

  constructor(@Inject(SYSTEM_DB) db: Db, api: LineApi) {
    super(db, api);
  }

  async send(ctx: SendContext) {
    const [g] = await this.db.select().from(s.lineGroups).where(and(eq(s.lineGroups.workspaceId, ctx.workspaceId), eq(s.lineGroups.id, ctx.targetRef)));
    if (!g) throw new UnrecoverableError('ไม่พบกลุ่ม LINE (OA อาจถูกนำออกจากกลุ่มแล้ว)');
    // คำขอเลื่อน Due ไม่ส่งเข้ากลุ่ม (ต้องอนุมัติรายคน) จึงส่งเป็นข้อความธรรมดาเสมอ
    await this.push(await this.token(ctx.workspaceId), g.lineGroupId, [{ type: 'text', text: text(ctx.msg) }]);
  }
}
