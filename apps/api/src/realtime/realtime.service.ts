import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type Db, schema } from '@friday/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';
import { webUrl } from '../auth/auth.config.js';
import { SessionService } from '../auth/sessions.js';
import { config } from '../config.js';
import { TenantDb } from '../common/tenant.js';
import { EventBus } from '../core/events.js';
import { SYSTEM_DB } from '../db/db.module.js';
import { projectAccess } from '../projects/permissions.js';

const s = schema;
const PATHS = new Set(['/realtime', '/api/v1/realtime']);
const MAX_SUBSCRIPTIONS = 50;
const HEARTBEAT_MS = 30_000;
/** ตรวจสิทธิ์และ Session ซ้ำเป็นระยะ: คนที่ถูกถอนสิทธิ์หรือออกจากระบบไม่รับสัญญาณต่อ */
const RECHECK_MS = 5 * 60_000;
const PRESENCE_STATES = new Set(['viewing', 'typing', 'idle']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Channel = `user:${string}` | `project:${string}` | `issue:${string}` | `import:${string}`;

interface Client {
  ws: WebSocket;
  userId: string;
  sessionId: string;
  subs: Set<string>;
  alive: boolean;
  /** presence ของ issue channel: channel → state */
  presence: Map<string, string>;
  presenceAt: number[];
}

/** Origin ที่เบราว์เซอร์เปิด WebSocket ได้ (กัน Cross-Site WebSocket Hijacking เพราะเบราว์เซอร์แนบคุกกี้ session ไปกับ handshake เสมอ) */
/** cookie ที่ encode ผิดรูปแบบ (เช่น `%`) ถือว่าไม่มี session แทนที่จะโยน URIError */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function allowedOrigins() {
  const extra = (process.env.REALTIME_ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return new Set([webUrl(), process.env.APP_URL?.replace(/\/$/, ''), ...extra].filter((x): x is string => !!x));
}

/** ช่วงย้อนอ่านแจ้งเตือนต่อรอบ ต้องยาวกว่าธุรกรรมที่เขียนแจ้งเตือนนานที่สุด */
const NOTIFY_OVERLAP_MS = 30_000;

/**
 * Realtime (WebSocket เดียวต่อแท็บที่ `/realtime`)
 * - ยืนยันตัวตนด้วยคุกกี้ session ตอน upgrade · ตรวจ Origin
 * - ข้อความเป็นแค่สัญญาณ (ช่อง + id + version) ไม่มีข้อมูลที่ต้องตรวจสิทธิ์ · ข้อมูลจริงดึงผ่าน REST
 * - subscribe ตรวจสิทธิ์ทุกครั้งผ่าน RLS / projectAccess และตรวจซ้ำทุก 5 นาที
 *
 * โมดูลอื่นส่งสัญญาณเองได้ด้วย `publish(channel, payload)` เช่น ความคืบหน้านำเข้า (`import:{jobId}`) หรือผูก LINE สำเร็จ (`user:{id}`)
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Realtime');
  private wss: WebSocketServer | null = null;
  private server: Server | null = null;
  private readonly clients = new Set<Client>();
  private readonly channels = new Map<string, Set<Client>>();
  private timers: NodeJS.Timeout[] = [];
  private notifyCursor = new Date();
  /** แจ้งเตือนที่ส่งไปแล้วในช่วงซ้อนทับ (id → created_at) กันส่งซ้ำ */
  private notifySeen = new Map<string, number>();
  /** เวลาที่ช่อง user:{id} เริ่มมีคนฟัง · แจ้งเตือนที่เก่ากว่านี้ไม่ต้องส่ง (หน้าเว็บโหลดจำนวนเองตอนเปิด) */
  private channelSince = new Map<string, number>();
  // ทุกทางเข้าแบบ async ต้องรับ rejection เอง: unhandled rejection ทำให้โปรเซส API จบ
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    void this.upgrade(req, socket, head).catch((err) => {
      this.log.warn(`upgrade failed: ${(err as Error).message}`);
      if (!socket.destroyed) this.reject(socket, 500, 'Internal Server Error');
    });

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly events: EventBus,
    private readonly tenantDb: TenantDb,
    private readonly sessions: SessionService,
    @Inject(SYSTEM_DB) private readonly db: Db,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapter.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    server.on('upgrade', this.onUpgrade);
    this.events.on('*', (e) => this.fromEvent(e));
    this.timers.push(
      setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref(),
      setInterval(() => void this.recheck().catch((err) => this.log.warn(`recheck failed: ${(err as Error).message}`)), RECHECK_MS).unref(),
      setInterval(
        () => void this.pollNotifications().catch((err) => this.log.warn(`notification poll failed: ${(err as Error).message}`)),
        Number(process.env.REALTIME_POLL_MS ?? 1500),
      ).unref(),
    );
  }

  onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    this.server?.off('upgrade', this.onUpgrade);
    for (const c of this.clients) c.ws.close(1001, 'server shutting down');
    this.wss?.close();
  }

  /** จำนวนการเชื่อมต่อ (ไว้ตรวจสอบ / test) */
  get connections() {
    return this.clients.size;
  }

  // ---------------------------------------------------------------------------
  // เชื่อมต่อ
  // ---------------------------------------------------------------------------
  private reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!PATHS.has(path)) return; // ไม่ใช่ของเรา (ปล่อยให้ listener อื่นจัดการ)
    socket.on('error', () => undefined);
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().has(origin.replace(/\/$/, ''))) return this.reject(socket, 403, 'Forbidden');
    const cookie = /(?:^|;\s*)fm_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const token = cookie ? safeDecode(cookie) : null;
    const session = token ? await this.sessions.find(token).catch(() => null) : null;
    if (!session) return this.reject(socket, 401, 'Unauthorized');
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.connect(ws, session.userId, session.sessionId));
  }

  private connect(ws: WebSocket, userId: string, sessionId: string) {
    const c: Client = { ws, userId, sessionId, subs: new Set(), alive: true, presence: new Map(), presenceAt: [] };
    this.clients.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw) =>
      void this.message(c, raw.toString()).catch((err) => {
        this.log.warn(`message failed: ${(err as Error).message}`);
        this.send(c, { op: 'error', code: 'internal_error', message: 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง' });
      }),
    );
    ws.on('close', () => this.drop(c));
    ws.on('error', () => this.drop(c));
    this.send(c, { op: 'ready', userId });
  }

  private drop(c: Client) {
    for (const ch of [...c.subs]) this.leave(c, ch, true);
    this.clients.delete(c);
  }

  private send(c: Client, msg: object) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  // ---------------------------------------------------------------------------
  // โปรโตคอล
  // ---------------------------------------------------------------------------
  private async message(c: Client, raw: string) {
    let m: { op?: string; channel?: string; id?: string; state?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return this.send(c, { op: 'error', code: 'invalid_message', message: 'ข้อความต้องเป็น JSON' });
    }
    // JSON ที่ถูกต้องแต่ไม่ใช่ object (null, array, ตัวเลข, ข้อความ) อ่าน field ไม่ได้
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      return this.send(c, { op: 'error', code: 'invalid_message', message: 'ข้อความต้องเป็น JSON object' });
    }
    const id = typeof m.id === 'string' ? m.id.slice(0, 64) : undefined;
    const channel = typeof m.channel === 'string' ? m.channel : '';
    switch (m.op) {
      case 'ping':
        return this.send(c, { op: 'pong', id });
      case 'subscribe': {
        if (c.subs.has(channel)) return this.send(c, { op: 'subscribed', channel, id });
        if (c.subs.size >= MAX_SUBSCRIPTIONS) return this.send(c, { op: 'error', channel, id, code: 'too_many_subscriptions', message: `subscribe ได้ไม่เกิน ${MAX_SUBSCRIPTIONS} ช่อง` });
        const ok = await this.authorize(c.userId, channel).catch(() => 'forbidden' as const);
        if (ok !== true) return this.send(c, { op: 'error', channel, id, code: ok, message: ok === 'invalid_channel' ? 'ชื่อช่องไม่ถูกต้อง' : 'ไม่มีสิทธิ์ subscribe ช่องนี้' });
        this.join(c, channel);
        this.send(c, { op: 'subscribed', channel, id });
        if (channel.startsWith('issue:')) this.send(c, { op: 'presence_list', channel, users: this.presenceOf(channel, c) });
        return;
      }
      case 'unsubscribe':
        this.leave(c, channel);
        return this.send(c, { op: 'unsubscribed', channel, id });
      case 'presence': {
        if (!c.subs.has(channel) || !channel.startsWith('issue:')) return this.send(c, { op: 'error', channel, id, code: 'not_subscribed', message: 'ต้อง subscribe ช่อง issue ก่อน' });
        if (!PRESENCE_STATES.has(String(m.state))) return this.send(c, { op: 'error', channel, id, code: 'invalid_message', message: 'state ต้องเป็น viewing · typing · idle' });
        // จำกัดความถี่ (พิมพ์ถี่ ๆ ไม่ท่วมคนอื่น): 10 ครั้งต่อวินาที
        const now = Date.now();
        c.presenceAt = c.presenceAt.filter((t) => now - t < 1000);
        if (c.presenceAt.length >= 10) return;
        c.presenceAt.push(now);
        c.presence.set(channel, String(m.state));
        return this.broadcast(channel, { type: 'presence', channel, userId: c.userId, state: m.state }, c);
      }
      default:
        return this.send(c, { op: 'error', id, code: 'unknown_op', message: 'op ไม่รู้จัก' });
    }
  }

  private join(c: Client, channel: string) {
    c.subs.add(channel);
    const set = this.channels.get(channel) ?? new Set();
    if (!set.size) this.channelSince.set(channel, Date.now());
    set.add(c);
    this.channels.set(channel, set);
  }

  private leave(c: Client, channel: string, silent = false) {
    c.subs.delete(channel);
    const set = this.channels.get(channel);
    set?.delete(c);
    if (set && !set.size) {
      this.channels.delete(channel);
      this.channelSince.delete(channel);
    }
    if (c.presence.delete(channel) && !silent) this.broadcast(channel, { type: 'presence', channel, userId: c.userId, state: 'left' }, c);
    else if (silent && channel.startsWith('issue:') && set) this.broadcast(channel, { type: 'presence', channel, userId: c.userId, state: 'left' }, c);
  }

  private presenceOf(channel: string, except: Client) {
    const out = new Map<string, string>();
    for (const o of this.channels.get(channel) ?? []) if (o !== except) out.set(o.userId, o.presence.get(channel) ?? 'viewing');
    return [...out].map(([userId, state]) => ({ userId, state }));
  }

  // ---------------------------------------------------------------------------
  // ส่งสัญญาณ
  // ---------------------------------------------------------------------------
  private broadcast(channel: string, msg: object, except?: Client) {
    for (const c of this.channels.get(channel) ?? []) if (c !== except) this.send(c, msg);
  }

  /** ส่งสัญญาณไปทุกคนที่ subscribe ช่องนั้น (ใช้จากโมดูลอื่น) · payload ต้องเป็นสัญญาณล้วน ไม่มีข้อมูลที่ต้องตรวจสิทธิ์ */
  publish(channel: Channel, payload: Record<string, unknown>) {
    this.broadcast(channel, { channel, at: new Date().toISOString(), ...payload });
  }

  /** Event ของระบบ → สัญญาณ `{ type, issueKey, id, version }` ไปช่องโปรเจกต์ (และช่องงาน) */
  private fromEvent(e: { type: string; projectId?: string; issueId?: string; actorId: string | null; data: Record<string, unknown> }) {
    if (!this.clients.size) return;
    const targets = [e.projectId && `project:${e.projectId}`, e.issueId && `issue:${e.issueId}`].filter((x): x is string => !!x && this.channels.has(x));
    if (!targets.length) return;
    void (async () => {
      let version: number | null = null;
      if (e.issueId) {
        const [row] = await this.db.select({ v: s.issues.version }).from(s.issues).where(eq(s.issues.id, e.issueId));
        version = row?.v ?? null;
      }
      const base = { type: e.type, issueKey: (e.data.issueKey as string | undefined) ?? null, id: e.issueId ?? null, version, actorId: e.actorId, at: new Date().toISOString() };
      for (const ch of targets) this.broadcast(ch, { channel: ch, ...base });
    })().catch((err) => this.log.warn(`event signal failed: ${(err as Error).message}`));
  }

  /**
   * แจ้งเตือนใหม่ → `user:{id}` พร้อมจำนวนยังไม่อ่านแยกตาม Workspace
   * ฟังจากตาราง (poll ทุก ~1.5 วินาที เฉพาะเมื่อมีคน subscribe ช่อง user) แทนการแก้ `notifier.ts` ซึ่งเป็นของ A23 และครอบคลุมแจ้งเตือนที่โมดูลอื่นเขียนตรง
   */
  private async pollNotifications() {
    const users = [...this.channels.keys()].filter((k) => k.startsWith('user:')).map((k) => k.slice(5));
    if (!users.length) {
      this.notifyCursor = new Date();
      return;
    }
    // created_at = now() คือเวลาเริ่มธุรกรรม แถวที่ธุรกรรมเริ่มก่อนรอบนี้แต่ commit หลัง select จะมี created_at
    // เก่ากว่า cursor · ถ้าอ่านเฉพาะ > cursor จะหลุดถาวร จึงอ่านย้อนช่วงซ้อนทับแล้วตัดตัวที่ส่งแล้วด้วย id
    const since = new Date(this.notifyCursor.getTime() - NOTIFY_OVERLAP_MS);
    // ใช้นาฬิกาของฐานข้อมูลเป็นจุดอ้างอิง กัน clock skew ระหว่างแอปกับฐานข้อมูล
    const [{ now }] = (await this.db.execute(sql`select clock_timestamp() as now`)).rows as Array<{ now: Date }>;
    const found = await this.db
      .select({ id: s.notifications.id, recipientId: s.notifications.recipientId, createdAt: s.notifications.createdAt })
      .from(s.notifications)
      .where(and(gt(s.notifications.createdAt, since), eq(s.notifications.inApp, true), sql`${s.notifications.recipientId} in (${sql.join(users.map((u) => sql`${u}::uuid`), sql`, `)})`));
    this.notifyCursor = new Date(now);
    const recipients = new Set<string>();
    for (const n of found) {
      if (this.notifySeen.has(n.id)) continue;
      const at = new Date(n.createdAt).getTime();
      this.notifySeen.set(n.id, at);
      if (at < (this.channelSince.get(`user:${n.recipientId}`) ?? 0)) continue;
      recipients.add(n.recipientId);
    }
    for (const [id, at] of this.notifySeen) if (at <= since.getTime()) this.notifySeen.delete(id);
    const rows = [...recipients].map((recipientId) => ({ recipientId }));
    for (const r of rows) await this.sendUnread(r.recipientId);
  }

  /**
   * จำนวนยังไม่อ่านเปลี่ยนจากการอ่าน / เสร็จ / เลื่อนเตือน (ไม่ใช่รายการใหม่) → `{ type: 'unread' }` ไปทุก session ของผู้รับ
   * poll ด้านบนดูเฉพาะแถวใหม่ จึงต้องให้คำสั่งเหล่านี้เรียกเองหลัง commit · ไม่มีคนฟังช่องนี้ = ไม่ต้องนับ
   */
  async unreadChanged(userId: string) {
    if (!this.channels.has(`user:${userId}`)) return;
    await this.sendUnread(userId, 'unread');
  }

  async sendUnread(userId: string, type: 'notification' | 'unread' = 'notification') {
    const rows = await this.db
      .select({ workspaceId: s.notifications.workspaceId, n: sql<number>`count(*)::int` })
      .from(s.notifications)
      .where(and(eq(s.notifications.recipientId, userId), eq(s.notifications.inApp, true), isNull(s.notifications.readAt), isNull(s.notifications.doneAt)))
      .groupBy(s.notifications.workspaceId);
    this.publish(`user:${userId}`, { type, unread: { total: rows.reduce((n, r) => n + r.n, 0), byWorkspace: Object.fromEntries(rows.map((r) => [r.workspaceId, r.n])) } });
  }

  // ---------------------------------------------------------------------------
  // สิทธิ์
  // ---------------------------------------------------------------------------
  /** true = subscribe ได้ · มิฉะนั้นรหัสข้อผิดพลาด */
  private async authorize(userId: string, channel: string): Promise<true | 'forbidden' | 'invalid_channel'> {
    const [kind, id] = channel.split(':');
    if (!id || !UUID.test(id) || !['user', 'project', 'issue', 'import'].includes(kind!)) return 'invalid_channel';
    if (kind === 'user') return id === userId ? true : 'forbidden';

    if (kind === 'import') {
      const [job] = await this.db.select({ by: s.importJobs.createdBy }).from(s.importJobs).where(eq(s.importJobs.id, id));
      return job?.by === userId ? true : 'forbidden';
    }

    // project / issue: หา Workspace ด้วย SYSTEM_DB แล้วตรวจสมาชิกและสิทธิ์โปรเจกต์ภายใต้ RLS ของผู้ใช้
    const target =
      kind === 'project'
        ? (await this.db.select({ workspaceId: s.projects.workspaceId, projectId: s.projects.id, shared: sql<boolean>`true`, typeId: sql<string>`null` }).from(s.projects).where(eq(s.projects.id, id)))[0]
        : (await this.db.select({ workspaceId: s.issues.workspaceId, projectId: s.issues.projectId, shared: s.issues.sharedWithGuests, typeId: s.issues.issueTypeId }).from(s.issues).where(eq(s.issues.id, id)))[0];
    if (!target) return 'forbidden';
    const [m] = await this.db.select({ role: s.workspaceMembers.role }).from(s.workspaceMembers).where(and(eq(s.workspaceMembers.workspaceId, target.workspaceId), eq(s.workspaceMembers.userId, userId), eq(s.workspaceMembers.status, 'active')));
    if (!m) return 'forbidden';
    const auth = { userId, sessionId: 'ws' };
    const tenant = { workspaceId: target.workspaceId, slug: '', role: m.role };
    return this.tenantDb.run(auth, tenant, async (tx) => {
      const [project] = await tx.select().from(s.projects).where(and(eq(s.projects.id, target.projectId), isNull(s.projects.deletedAt)));
      if (!project) return 'forbidden' as const; // RLS ซ่อนโปรเจกต์ Private ที่ไม่ได้เป็นสมาชิก
      const access = await projectAccess(tx, auth, tenant, project);
      if (!access.role) return 'forbidden' as const;
      if (access.guestViewer) {
        // Guest เห็นเฉพาะงานที่แชร์ (และไม่ใช่ Bug) · ช่องโปรเจกต์ทั้งก้อนไม่ให้
        if (kind === 'project') return 'forbidden' as const;
        const [t] = await tx.select({ name: s.issueTypes.name }).from(s.issueTypes).where(eq(s.issueTypes.id, target.typeId));
        if (!target.shared || t?.name === 'Bug') return 'forbidden' as const;
      }
      return true as const;
    });
  }

  /** ตรวจ Session และสิทธิ์ของทุก subscription ซ้ำ · ที่หมดสิทธิ์ถูกถอดออก · Session หมดอายุ/ถูกยกเลิก = ปิดการเชื่อมต่อ */
  async recheck() {
    for (const c of [...this.clients]) {
      try {
        if (!(await this.sessionValid(c.sessionId))) {
          c.ws.close(4401, 'session ended');
          continue;
        }
        for (const ch of [...c.subs]) {
          if ((await this.authorize(c.userId, ch)) !== true) {
            this.leave(c, ch);
            this.send(c, { op: 'unsubscribed', channel: ch, reason: 'forbidden' });
          }
        }
      } catch (err) {
        this.log.warn(`recheck failed: ${(err as Error).message}`);
      }
    }
  }

  /** เหมือน SessionService.find แต่ไม่ต่ออายุ lastSeenAt (แท็บที่เปิดค้างไม่ควรทำให้ session ไม่ idle หมดอายุ) */
  private async sessionValid(sessionId: string) {
    const [row] = await this.db
      .select({ id: s.userSessions.id })
      .from(s.userSessions)
      .innerJoin(s.users, eq(s.users.id, s.userSessions.userId))
      .where(
        and(
          eq(s.userSessions.id, sessionId),
          isNull(s.userSessions.revokedAt),
          isNull(s.users.disabledAt),
          sql`(${s.userSessions.rememberUntil} > now() or ${s.userSessions.lastSeenAt} > now() - make_interval(hours => ${config.sessionIdleHours}))`,
        ),
      );
    return !!row;
  }
}

