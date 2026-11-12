import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@friday/db';
import { sql } from 'drizzle-orm';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { Notifier } from '../notifications/notifier.js';
import { Jobs } from '../queue/jobs.js';

export const SUPPORT_REPLIED = 'support.replied';
const JOB = 'help.support-replies';

/**
 * แจ้งเตือนลูกค้าในกระดิ่งเมื่อทีม Friday ตอบ Ticket (support.replied · X6 / T12)
 * คำตอบเขียนโดย ops-api ซึ่งเป็นอีกโปรเซส (ส่งอีเมลเองแล้ว) จึงสแกนข้อความใหม่ทุกนาทีแทนการรับ Event ข้ามโปรเซส
 * กันแจ้งซ้ำด้วย dedupeKey = ข้อความ · ข้อความเก่ากว่า 2 วันไม่แจ้งย้อนหลัง (เช่น เปิดระบบครั้งแรก)
 */
@Injectable()
export class SupportRepliesJob implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SupportReplies');
  private timer?: NodeJS.Timeout;

  constructor(
    // support_ticket_messages เป็นตาราง ops_only และต้องอ่านข้ามทุก Workspace จึงใช้ SYSTEM_DB
    @Inject(SYSTEM_DB) private readonly db: Db,
    private readonly notifier: Notifier,
    private readonly events: EventBus,
    private readonly jobs: Jobs,
  ) {}

  async onModuleInit() {
    this.jobs.define(JOB, () => this.scan());
    await this.jobs.every(JOB, '* * * * *');
    // โหมด inline (ไม่มี Valkey เช่น Docker บนเครื่อง) ไม่รันงานตามเวลา จึงตั้งเวลาเองในโปรเซส · test เรียก scan() เอง
    if (this.jobs.mode === 'inline' && !process.env.VITEST) {
      this.timer = setInterval(() => void this.scan().catch((e) => this.log.error(String(e))), 60_000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async scan() {
    const r = await this.db.execute(sql`
      select m.id, m.body, m.author_kind as "authorKind", m.created_at as "createdAt", k.id as "ticketId", k.number, k.subject, k.workspace_id as "workspaceId", k.requester_user_id as "userId", k.status
      from support_ticket_messages m join support_tickets k on k.id = m.ticket_id
      where m.author_kind in ('staff', 'system') and not m.internal and m.created_at > now() - interval '2 days'
        and k.workspace_id is not null and k.requester_user_id is not null
        and exists (select 1 from workspace_members wm where wm.workspace_id = k.workspace_id and wm.user_id = k.requester_user_id and wm.status = 'active')
        and not exists (select 1 from notifications n where n.recipient_id = k.requester_user_id and n.event_type = ${SUPPORT_REPLIED} and n.payload->>'dedupeKey' = 'support:' || m.id::text)
      order by m.created_at limit 200`);
    const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as { id: string; body: string; authorKind: string; createdAt: Date; ticketId: string; number: number; subject: string; workspaceId: string; userId: string; status: string }[];
    for (const m of rows) {
      const solved = m.status === 'solved' || m.status === 'closed';
      await this.notifier.notify({
        workspaceId: m.workspaceId,
        recipientIds: [m.userId],
        eventType: SUPPORT_REPLIED,
        actorId: null,
        payload: {
          title: `${solved ? 'ทีม Friday แก้ปัญหาที่คุณแจ้งแล้ว' : 'ทีม Friday ตอบเรื่องที่คุณแจ้ง'} · #${m.number} ${m.subject}`,
          ticketId: m.ticketId,
          ticketNumber: m.number,
          message: m.body.slice(0, 200),
        },
        reason: 'คุณเป็นผู้แจ้ง Ticket นี้',
        dedupeKey: `support:${m.id}`,
      });
      await this.events.publish({ type: 'support.replied', workspaceId: m.workspaceId, actorId: null, data: { ticketId: m.ticketId, number: m.number, subject: m.subject, messageId: m.id, userIds: [m.userId] }, at: new Date(m.createdAt) });
    }
    return { notified: rows.length };
  }
}
