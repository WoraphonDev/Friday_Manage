import { Fragment, type ReactNode } from "react";
import styles from "../help.module.css";

/**
 * แสดง Markdown ของบทความ (ดูตัวอย่างใน 19b) · ไวยากรณ์ชุดเดียวกับหน้าบทความของเว็บลูกค้า
 * หัวข้อ ## / ### · ย่อหน้า · **หนา** · *เอียง* · `โค้ด` · รายการ - / 1. · ลิงก์ · รูป · กล่องเตือน :::info|tip|warning … ::: · ลิงก์ในแอป [ข้อความ](app:/admin/trash)
 * สร้างเป็น React element ทั้งหมด ไม่ใช้ HTML ดิบ · URL ที่ไม่ใช่ https / http / app: / ทางในเว็บ แสดงเป็นข้อความธรรมดา
 */
export type Callout = "info" | "tip" | "warning";

const SAFE_URL = /^(https?:\/\/|\/(?!\/))/i;
const APP_URL = /^app:(\/[\w\-./?=&%#]*)$/i;

/** ลิงก์ในแอปลูกค้า `app:/admin/trash` → เส้นทางใน Workspace ปัจจุบัน (ฝั่ง ops แสดงเป็นป้าย) */
export const appPath = (url: string) => APP_URL.exec(url)?.[1] ?? null;

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("![")) {
      const [, alt, url] = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!;
      // eslint-disable-next-line @next/next/no-img-element
      out.push(SAFE_URL.test(url!) ? <img key={k} className={styles.mdImg} src={url} alt={alt} loading="lazy" /> : alt);
    } else if (tok.startsWith("[")) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const app = appPath(url!);
      if (app) out.push(<span key={k} className={styles.appLink} title={app}>{inline(label!, k)} ↗</span>);
      else if (SAFE_URL.test(url!)) out.push(<a key={k} href={url} target="_blank" rel="noreferrer noopener">{inline(label!, k)}</a>);
      else out.push(label);
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** ข้อความหัวข้อ → id สำหรับสารบัญ */
export const headingId = (text: string, i: number) => `h-${i}-${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

function blocks(src: string, prefix: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${prefix}-${n++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const callout = /^:::\s*(info|tip|warning)\s*$/i.exec(trimmed);
    if (callout) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== ":::") body.push(lines[i++]!);
      i++;
      const kind = callout[1]!.toLowerCase() as Callout;
      const k = key();
      out.push(
        <div key={k} className={`${styles.callout} ${styles[`callout_${kind}`]}`} role="note" data-callout={kind}>
          {blocks(body.join("\n"), k)}
        </div>,
      );
      continue;
    }
    const h = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (h) {
      const k = key();
      const Tag = h[1]!.length === 2 ? "h2" : "h3";
      out.push(
        <Tag key={k} id={headingId(h[2]!, n)}>
          {inline(h[2]!, k)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^([-*])\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const re = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i]!.trim())) items.push(re.exec(lines[i++]!.trim())![1]!);
      const k = key();
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={k}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    // บรรทัดแรกเข้าย่อหน้าเสมอ (กัน :::ที่ไม่รู้จัก หรือ # เดี่ยว วนไม่จบ)
    const para: string[] = [lines[i++]!.trim()];
    while (i < lines.length && lines[i]!.trim() && !/^(#{2,3}\s|:::|[-*]\s|\d+\.\s)/.test(lines[i]!.trim())) para.push(lines[i++]!.trim());
    const k = key();
    out.push(
      <p key={k}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  return <div className={styles.md}>{blocks(source, "b")}</div>;
}
