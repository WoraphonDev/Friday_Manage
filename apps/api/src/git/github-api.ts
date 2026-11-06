import { createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
}

const b64 = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString('base64url');

/**
 * เรียก GitHub App API · แยกเป็น class เพื่อให้ test แทนที่ได้ (ไม่ยิง GitHub จริง)
 * env: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY (PEM · ใส่ \n เป็นตัวอักษร `\\n` ได้), GITHUB_WEBHOOK_SECRET
 */
@Injectable()
export class GithubApi {
  get configured() {
    return !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_PRIVATE_KEY);
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

  private async call<T>(token: string, path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'FridayManage' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ตอบ HTTP ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }

  /** บัญชีที่ติดตั้ง App (ใช้ตอนกลับจากหน้า Install) */
  async installation(installationId: string): Promise<{ accountName: string }> {
    const r = await this.call<{ account?: { login?: string } }>(this.appJwt(), `/app/installations/${encodeURIComponent(installationId)}`);
    return { accountName: r.account?.login ?? installationId };
  }

  /** repository ที่ App เข้าถึงได้ */
  async repositories(installationId: string): Promise<GithubRepo[]> {
    const t = await this.call<{ token: string }>(this.appJwt(), `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, 'POST');
    const r = await this.call<{ repositories: Array<{ full_name: string; default_branch?: string }> }>(t.token, '/installation/repositories?per_page=100');
    return r.repositories.map((x) => ({ fullName: x.full_name, defaultBranch: x.default_branch ?? 'main' }));
  }
}
