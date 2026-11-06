import { createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
}

const b64 = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString('base64url');
const API = 'https://api.github.com';
/** กันวนไม่จบ: 100 หน้า × 100 รายการ */
const MAX_PAGES = 100;

/** URL หน้าถัดไปจาก header Link · รับเฉพาะ api.github.com (ไม่ตาม URL อื่นไปพร้อม token) */
export function nextPage(link: string | null): string | null {
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  return m && m[1].startsWith(`${API}/`) ? m[1] : null;
}

/**
 * เรียก GitHub App API · แยกเป็น class เพื่อให้ test แทนที่ได้ (ไม่ยิง GitHub จริง)
 * env: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY (PEM · ใส่ \n เป็นตัวอักษร `\\n` ได้), GITHUB_WEBHOOK_SECRET
 * และ GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET ของ App (ต้องเปิด "Request user authorization (OAuth) during installation")
 */
@Injectable()
export class GithubApi {
  /** ต้องมี OAuth ของ App ด้วย: ตอนกลับจากหน้า Install ใช้พิสูจน์ว่าผู้ติดตั้งเข้าถึง installation นั้นจริง (BUG-01) */
  get configured() {
    return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  }

  installUrl(state: string) {
    return `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** JWT ของ App (RS256) อายุ 9 นาที ใช้ขอ installation token */
  private appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID })}`;
    const sig = createSign('RSA-SHA256').update(input).sign((process.env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'));
    return `${input}.${b64(sig)}`;
  }

  private async fetchJson<T>(token: string, url: string, method: 'GET' | 'POST' = 'GET') {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'FridayManage' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ตอบ HTTP ${res.status}`), { status: res.status });
    return { body: (await res.json()) as T, next: nextPage(res.headers.get('link')) };
  }

  private async call<T>(token: string, path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    return (await this.fetchJson<T>(token, `${API}${path}`, method)).body;
  }

  /** อ่านครบทุกหน้า · หน้าไหนล้ม = throw ทั้งชุด (ผู้เรียกต้องไม่ถือว่าได้รายการครบ) */
  private async all<T>(token: string, path: string, pick: (body: Record<string, unknown>) => T[]): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${API}${path}`;
    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES) throw new Error('GitHub ส่งหน้ามากเกินไป');
      const r: { body: Record<string, unknown>; next: string | null } = await this.fetchJson<Record<string, unknown>>(token, url);
      out.push(...pick(r.body));
      url = r.next;
    }
    return out;
  }

  /**
   * ผู้ใช้ GitHub ที่เพิ่งติดตั้งเข้าถึง installation นี้ได้จริงหรือไม่ (BUG-01)
   * แลก `code` (ใช้ได้ครั้งเดียว) เป็น user token แล้วดู `GET /user/installations` · state ของ Friday พิสูจน์แค่ Workspace ไม่ได้พิสูจน์ installation
   */
  async userCanAccess(code: string, installationId: string): Promise<boolean> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'FridayManage' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !tok.access_token) return false;
    const ids = await this.all(tok.access_token, '/user/installations?per_page=100', (b) => ((b.installations as Array<{ id: number }> | undefined) ?? []).map((i) => String(i.id)));
    return ids.includes(installationId);
  }

  /** บัญชีที่ติดตั้ง App (ใช้ตอนกลับจากหน้า Install) */
  async installation(installationId: string): Promise<{ accountName: string }> {
    const r = await this.call<{ account?: { login?: string } }>(this.appJwt(), `/app/installations/${encodeURIComponent(installationId)}`);
    return { accountName: r.account?.login ?? installationId };
  }

  /** repository ที่ App เข้าถึงได้ · ตามทุกหน้า (BUG-14: เดิมอ่านแค่ 100 รายการแรก แล้ว sync ลบที่เหลือทิ้ง) */
  async repositories(installationId: string): Promise<GithubRepo[]> {
    const t = await this.call<{ token: string }>(this.appJwt(), `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, 'POST');
    const repos = await this.all(t.token, '/installation/repositories?per_page=100', (b) => (b.repositories as Array<{ full_name: string; default_branch?: string }> | undefined) ?? []);
    return repos.map((x) => ({ fullName: x.full_name, defaultBranch: x.default_branch ?? 'main' }));
  }
}
