import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

// ── เข้ารหัส token / webhook secret ก่อนเก็บใน dev_bridge_settings (*_enc) ─────────────
// กุญแจ = OPS_SECRETS_KEY (production ตั้งแยก) หรือ sha256 ของ OPS_AUTH_SECRET · AES-256-GCM: iv.tag.ciphertext (base64url)
const key = () => createHash('sha256').update(`dev-bridge:${process.env.OPS_SECRETS_KEY ?? config.secret}`).digest();

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(enc: string | null) {
  if (!enc) return null;
  try {
    const [iv, tag, data] = enc.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** ลายเซ็น Webhook ของ Friday Work Management (A25): `sha256=` HMAC-SHA256 ของ `${timestamp}.${body}` */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now = Date.now()) {
  if (!timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface FmIssue {
  key: string;
  title: string;
  description: string | null;
  status: { id: string; name: string; category: string };
  priority: string;
  planEnd: string | null;
  sprintId: string | null;
  assigneeIds: string[];
  labels?: unknown;
}

export interface FmTarget {
  apiBaseUrl: string;
  workspaceSlug: string;
  projectKey: string;
  token: string;
}

type Fetcher = typeof fetch;

/**
 * เรียก API ของ Friday Work Management (Workspace ของทีมพัฒนา) ด้วย API token (A28) เหมือนระบบภายนอก
 * ปลายทางเป็น URL ภายในเครือข่าย Docker / VPS (เช่น http://api:3001) · timeout 10 วินาที
 */
export class FmClient {
  /** test เปลี่ยนเป็น fetch ของ API จำลองได้ */
  static fetcher: Fetcher = (...a) => fetch(...a);

  constructor(private readonly t: FmTarget) {}

  private get ws() {
    return `/w/${encodeURIComponent(this.t.workspaceSlug)}`;
  }
  private get project() {
    return `${this.ws}/projects/${encodeURIComponent(this.t.projectKey)}`;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await FmClient.fetcher(`${this.t.apiBaseUrl.replace(/\/$/, '')}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${this.t.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new AppError(502, 'fm_unreachable', `ต่อ Friday Work Management ของทีมพัฒนาไม่ได้: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 401 || res.status === 403) throw new AppError(502, 'fm_token_rejected', `Friday Work Management ปฏิเสธ API token (${err?.message ?? res.status}) · ตรวจการตั้งค่าการเชื่อมต่อ`);
      if (res.status === 404) throw new AppError(404, 'fm_not_found', err?.message ?? 'ไม่พบงานใน Friday Work Management');
      throw new AppError(502, 'fm_error', `Friday Work Management ตอบ ${res.status}: ${err?.message ?? 'ผิดพลาด'}`);
    }
    return data as T;
  }

  me() {
    return this.call<{ id: string; displayName: string }>('GET', '/me');
  }
  getProject() {
    return this.call<{ id: string; key: string; name: string }>('GET', this.project);
  }
  async statuses() {
    const r = await this.call<{ items: { kind: string; statuses: { id: string; name: string; category: string }[] }[] }>('GET', `${this.project}/workflows`);
    return r.items.flatMap((w) => w.statuses.map((s) => ({ ...s, workflow: w.kind })));
  }
  getIssue(issueKey: string) {
    return this.call<FmIssue>('GET', `${this.ws}/issues/${encodeURIComponent(issueKey)}`);
  }
  async searchBugs(q: string, limit = 10) {
    const r = await this.call<{ items: FmIssue[] }>('GET', `${this.project}/issues?type=Bug&q=${encodeURIComponent(q)}&limit=${limit}`);
    return r.items;
  }
  /** Label ของงานจาก Support (สร้างให้ถ้ายังไม่มี) */
  async labelId(name: string) {
    const r = await this.call<{ items: { id: string; name: string }[] } | { id: string; name: string }[]>('GET', `${this.project}/labels`);
    const list = Array.isArray(r) ? r : r.items;
    const hit = list.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    const created = await this.call<{ id: string } | { label: { id: string } }>('POST', `${this.project}/labels`, { name });
    return 'label' in created ? created.label.id : created.id;
  }
  createBug(input: { title: string; description: string; priority: string; labelIds: string[]; severity: 'critical' | 'major' | 'minor'; environment: 'production'; details: { steps: string } }) {
    return this.call<FmIssue>('POST', `${this.project}/issues`, { type: 'Bug', ...input });
  }
  comment(issueKey: string, body: string) {
    return this.call('POST', `${this.ws}/issues/${encodeURIComponent(issueKey)}/comments`, { body });
  }
  /** ชื่อผู้รับผิดชอบและ Sprint (ไม่จำเป็น · ดึงไม่ได้ก็ข้าม) */
  async names() {
    const people = new Map<string, string>();
    const sprints = new Map<string, string>();
    try {
      const m = await this.call<{ items: Record<string, unknown>[] }>('GET', `${this.project}/members`);
      for (const x of m.items ?? []) {
        const user = (x.user ?? x) as { id?: string; displayName?: string };
        const id = (x.userId as string | undefined) ?? user.id;
        if (id && user.displayName) people.set(id, user.displayName);
      }
    } catch {
      // ข้าม
    }
    try {
      const b = await this.call<{ sprints?: { id: string; name: string }[] }>('GET', `${this.project}/backlog`);
      for (const sp of b.sprints ?? []) sprints.set(sp.id, sp.name);
    } catch {
      // ข้าม
    }
    return { people, sprints };
  }
}
