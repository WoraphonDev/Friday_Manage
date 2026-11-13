import { createHmac } from 'node:crypto';
import type { Msg } from './message.js';

export type WebhookFormat = 'json' | 'discord' | 'slack' | 'teams' | 'telegram';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hexToInt = (hex: string) => parseInt(hex.replace('#', ''), 16);

const FOOTER = {
  th: { because: (why: string) => `คุณได้รับอีเมลนี้เพราะ${why}`, settings: 'ตั้งค่าการแจ้งเตือน', open: 'เปิดในแอป', more: (n: number) => `และอีก ${n} งาน` },
  en: { because: (why: string) => `You received this email because: ${why}`, settings: 'Notification settings', open: 'Open in app', more: (n: number) => `and ${n} more` },
} as const;

export function renderEmail(m: Msg, why: string, settingsUrl: string) {
  const F = FOOTER[m.locale ?? 'th'];
  const subject = `[Friday] ${m.head}${m.title ? `: ${m.title}` : ''}`;
  const text = [
    `${m.head}: ${m.title}`,
    m.project,
    ...(m.body ? ['', m.body, ''] : []),
    ...m.rows.map(([k, v]) => `${k}: ${v}`),
    m.note ? `“${m.note}”` : '',
    ...(m.lists ?? []).flatMap((l) => ['', l.label, ...l.items.map((i) => `- ${i.text}\n  ${i.url}`), ...(l.more ? [`  ${F.more(l.more)}`] : [])]),
    '',
    `${m.buttons[0]?.label ?? F.open}: ${m.url}`,
    '',
    `${F.because(why)} · ${F.settings}: ${settingsUrl}`,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<div style="border-top:4px solid ${esc(m.color)};padding:16px 0">
<h2 style="margin:0 0 4px">${esc(m.head)}: ${esc(m.title)}</h2>
<div style="color:#5F6873">${esc(m.project)}</div>
${m.body ? `<p style="white-space:pre-wrap;line-height:1.6">${esc(m.body)}</p>` : ''}
${m.rows.map(([k, v]) => `<div><b>${esc(k)}</b> ${esc(v)}</div>`).join('')}
${m.note ? `<blockquote>${esc(m.note)}</blockquote>` : ''}
${(m.lists ?? [])
  .map(
    (l) =>
      `<h3 style="margin:16px 0 4px;font-size:14px">${esc(l.label)}</h3><ul style="margin:0;padding-left:20px">${l.items.map((i) => `<li><a href="${esc(i.url)}">${esc(i.text)}</a></li>`).join('')}${l.more ? `<li style="color:#5F6873">${esc(F.more(l.more))}</li>` : ''}</ul>`,
  )
  .join('')}
<p><a href="${esc(m.url)}" style="background:#1D4ED8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(m.buttons[0]?.label ?? F.open)}</a></p>
<p style="color:#5F6873;font-size:12px">${esc(F.because(why))} · <a href="${esc(settingsUrl)}">${esc(F.settings)}</a></p>
</div></div>`;
  return { subject, text, html };
}

/** รูปแบบ JSON ทั่วไป (N2 › Payload) */
export function jsonPayload(m: Msg, workspace: string) {
  return {
    event: m.event,
    workspace,
    project: m.project,
    title: m.title,
    head: m.head,
    url: m.url,
    ...(m.safe ? {} : { fields: Object.fromEntries(m.rows), ...(m.note ? { note: m.note } : {}) }),
  };
}

/** แปลงข้อความเดียวกันเป็นรูปแบบของ Discord / Slack / Teams / Telegram */
export function renderWebhook(format: WebhookFormat, m: Msg, workspace: string, target: { chatId?: string } = {}): unknown {
  switch (format) {
    case 'discord':
      return {
        username: 'Friday Work Management',
        embeds: [
          {
            title: m.head,
            description: [m.title, m.project].filter(Boolean).join('\n'),
            url: m.url,
            color: hexToInt(m.color),
            fields: m.rows.map(([name, value]) => ({ name, value, inline: true })),
            ...(m.note ? { footer: { text: m.note } } : {}),
          },
        ],
      };
    case 'slack':
      return {
        text: `${m.head}: ${m.title}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${m.head}*\n${m.title}\n_${m.project}_` } },
          ...(m.rows.length ? [{ type: 'section', fields: m.rows.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })) }] : []),
          { type: 'actions', elements: m.buttons.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, url: b.url })) },
        ],
      };
    case 'teams':
      return {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: m.head,
        themeColor: m.color.replace('#', ''),
        title: m.head,
        text: [m.title, m.project].filter(Boolean).join(' · '),
        sections: m.rows.length ? [{ facts: m.rows.map(([name, value]) => ({ name, value })) }] : [],
        potentialAction: m.buttons.map((b) => ({ '@type': 'OpenUri', name: b.label, targets: [{ os: 'default', uri: b.url }] })),
      };
    case 'telegram':
      return {
        chat_id: target.chatId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text: [`<b>${esc(m.head)}</b>`, esc(m.title), esc(m.project), ...m.rows.map(([k, v]) => `${esc(k)}: ${esc(v)}`), `<a href="${esc(m.url)}">${esc(m.buttons[0]?.label ?? 'เปิดในแอป')}</a>`]
          .filter(Boolean)
          .join('\n'),
      };
    default:
      return jsonPayload(m, workspace);
  }
}

/** ลายเซ็นของ Webhook: HMAC-SHA256 ของ `${timestamp}.${body}` · ผู้รับตรวจ timestamp เพื่อกัน replay */
export function sign(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
