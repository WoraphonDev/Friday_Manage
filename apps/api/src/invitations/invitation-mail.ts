// อีเมลคำเชิญเข้า Workspace (A14) · ภาษาตามค่าเริ่มต้นของ Workspace เพราะผู้รับอาจยังไม่มีบัญชี (ไม่รู้ภาษาที่ตั้งไว้)

export interface InvitationMail {
  to: string;
  inviteUrl: string;
  expiresAt: Date;
  workspaceName: string;
  inviterName: string;
  projectName: string | null;
  message: string | null;
  locale: 'th' | 'en';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const T = {
  th: {
    subject: (m: InvitationMail) => `${m.inviterName} เชิญคุณเข้าร่วม ${m.workspaceName} บน Friday Manage`,
    head: (m: InvitationMail) => `${m.inviterName} เชิญคุณเข้าร่วม Workspace “${m.workspaceName}”`,
    project: (name: string) => `โปรเจกต์: ${name}`,
    button: 'รับคำเชิญ',
    expires: (d: string) => `ลิงก์นี้ใช้ได้ถึง ${d}`,
    ignore: 'ถ้าไม่รู้จักผู้เชิญ ไม่ต้องทำอะไร คำเชิญจะหมดอายุเอง',
  },
  en: {
    subject: (m: InvitationMail) => `${m.inviterName} invited you to ${m.workspaceName} on Friday Manage`,
    head: (m: InvitationMail) => `${m.inviterName} invited you to join the “${m.workspaceName}” workspace`,
    project: (name: string) => `Project: ${name}`,
    button: 'Accept invitation',
    expires: (d: string) => `This link works until ${d}`,
    ignore: "If you don't know the sender, you can ignore this email. The invitation will expire on its own.",
  },
};

export function renderInvitationEmail(m: InvitationMail) {
  const L = T[m.locale];
  const when = new Intl.DateTimeFormat(m.locale === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(m.expiresAt);
  const subject = L.subject(m);
  const text = [L.head(m), m.projectName ? L.project(m.projectName) : '', m.message ? `“${m.message}”` : '', `${L.button}: ${m.inviteUrl}`, L.expires(when), L.ignore].filter(Boolean).join('\n\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<div style="border-top:4px solid #15803D;padding:16px 0">
<h2 style="margin:0 0 8px">${esc(L.head(m))}</h2>
${m.projectName ? `<div style="color:#5F6873">${esc(L.project(m.projectName))}</div>` : ''}
${m.message ? `<blockquote style="margin:12px 0;padding-left:12px;border-left:3px solid #D0D5DB">${esc(m.message).replace(/\r?\n/g, '<br>')}</blockquote>` : ''}
<p style="margin:20px 0"><a href="${esc(m.inviteUrl)}" style="background:#1D4ED8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(L.button)}</a></p>
<p style="color:#5F6873;font-size:13px">${esc(L.expires(when))}</p>
<p style="color:#5F6873;font-size:12px">${esc(L.ignore)}<br><a href="${esc(m.inviteUrl)}">${esc(m.inviteUrl)}</a></p>
</div></div>`;
  return { subject, text, html };
}
