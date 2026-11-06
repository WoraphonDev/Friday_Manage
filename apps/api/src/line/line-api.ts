import { Injectable } from '@nestjs/common';

const BASE = 'https://api.line.me/v2/bot';

export type LineMessage = { type: 'text'; text: string } | { type: 'flex'; altText: string; contents: Record<string, unknown> };

/**
 * เรียก LINE Messaging API · แยกเป็น class เพื่อให้ test แทนที่เป็นตัวปลอมได้ (ไม่ยิง LINE จริง)
 * ล้ม (HTTP ไม่ใช่ 2xx) → throw Error ที่มีสถานะ ให้ผู้เรียกตัดสินว่าจะ retry หรือไม่
 */
@Injectable()
export class LineApi {
  private async call<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`LINE ตอบ HTTP ${res.status}`), { status: res.status });
    return (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T;
  }

  push(token: string, to: string, messages: LineMessage[]) {
    return this.call(token, 'POST', '/message/push', { to, messages });
  }

  reply(token: string, replyToken: string, messages: LineMessage[]) {
    return this.call(token, 'POST', '/message/reply', { replyToken, messages });
  }

  profile(token: string, userId: string) {
    return this.call<{ displayName?: string }>(token, 'GET', `/profile/${encodeURIComponent(userId)}`);
  }

  groupSummary(token: string, groupId: string) {
    return this.call<{ groupName?: string }>(token, 'GET', `/group/${encodeURIComponent(groupId)}/summary`);
  }

  /** ตรวจว่า access token ใช้ได้ */
  botInfo(token: string) {
    return this.call<{ displayName?: string; basicId?: string }>(token, 'GET', '/info');
  }
}
