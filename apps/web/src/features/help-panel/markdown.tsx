"use client";

import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Info, Lightbulb, TriangleAlert } from "lucide-react";
import styles from "./help.module.css";

/**
 * เนื้อหาบทความ (Markdown + กล่องเตือน 3 แบบ ตามคำตัดสิน O35) · แสดงผ่าน react-markdown ซึ่งไม่แปล HTML ดิบ
 * จึงไม่มีการฉีด HTML จากบทความ · ลิงก์อนุญาตเฉพาะ https / http / mailto / ภายในเว็บ / app:/… (หน้าในแอป)
 */
export type CalloutKind = "info" | "tip" | "warning";
type Block = { kind: "md"; text: string } | { kind: "callout"; type: CalloutKind; text: string };

/** แยกกล่องเตือน `:::info` … `:::` ออกจาก Markdown ปกติ */
export function splitCallouts(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let buf: string[] = [];
  let callout: { type: CalloutKind; lines: string[] } | null = null;
  const flush = () => {
    if (buf.join("").trim()) out.push({ kind: "md", text: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    const open = /^:::\s*(info|tip|warning)\s*$/.exec(line.trim());
    if (!callout && open) {
      flush();
      callout = { type: open[1] as CalloutKind, lines: [] };
    } else if (callout && line.trim() === ":::") {
      out.push({ kind: "callout", type: callout.type, text: callout.lines.join("\n") });
      callout = null;
    } else if (callout) callout.lines.push(line);
    else buf.push(line);
  }
  if (callout) out.push({ kind: "callout", type: callout.type, text: callout.lines.join("\n") });
  flush();
  return out;
}

/** id ของหัวข้อจากข้อความ (ใช้ทั้งในสารบัญและในเนื้อหา) */
export const headingId = (value: string) => `sec-${value.trim().replace(/[\s/]+/g, "-").replace(/[^\p{L}\p{N}\p{M}-]/gu, "").toLowerCase()}`;
const plainHeading = (raw: string) => raw.replace(/[*_`]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();

/** สารบัญ "ในบทความนี้" จากหัวข้อระดับ 2 นอกกล่องเตือนและนอก code block */
export function tocOf(md: string) {
  const items: { id: string; text: string }[] = [];
  let fenced = false;
  for (const block of splitCallouts(md)) {
    if (block.kind !== "md") continue;
    for (const line of block.text.split("\n")) {
      if (/^```/.test(line.trim())) fenced = !fenced;
      const m = !fenced && /^##\s+(.+?)\s*#*$/.exec(line);
      if (m) items.push({ id: headingId(plainHeading(m[1])), text: plainHeading(m[1]) });
    }
  }
  return items;
}

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? text(c.props.children) : ""))
    .join("");

/**
 * แปลงลิงก์ในบทความ · `app:/admin/trash` = หน้าในแอปของ Workspace ปัจจุบัน (หน้าสาธารณะพาไปเข้าสู่ระบบก่อน)
 * โปรโตคอลอื่น (javascript:, data: ฯลฯ) ตัดทิ้ง
 */
export function articleUrl(url: string, appBase: string | null, kind: "link" | "image" = "link") {
  const value = url.trim();
  if (/^app:\//i.test(value)) {
    if (kind === "image") return "";
    const path = value.replace(/^app:/i, "").replace(/^\/+/, "/");
    if (!/^\/[\w\-./?=&#%]*$/.test(path) || path.includes("..")) return "";
    return appBase ? `${appBase}${path}` : `/login?next=${encodeURIComponent(path)}`;
  }
  if (/^https?:\/\//i.test(value)) return value;
  if (kind === "link" && /^mailto:/i.test(value)) return value;
  if (/^\/(?!\/)/.test(value) || value.startsWith("#")) return value;
  return "";
}

function Callout({ type, children }: { type: CalloutKind; children: ReactNode }) {
  const t = useTranslations("help.callout");
  const Icon = type === "warning" ? TriangleAlert : type === "tip" ? Lightbulb : Info;
  return (
    <aside className={`${styles.callout} ${styles[`callout_${type}`]}`} role="note" aria-label={t(type)}>
      <Icon size={16} aria-hidden="true" />
      <div>{children}</div>
    </aside>
  );
}

export function ArticleBody({ body, appBase }: { body: string; appBase: string | null }) {
  const components: Components = {
    h2: ({ children }) => <h2 id={headingId(text(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(text(children))}>{children}</h3>,
    a: ({ href, children }) => {
      if (!href) return <>{children}</>;
      const external = /^https?:\/\//i.test(href);
      return external ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <a href={href}>{children}</a>
      );
    },
    // รูปจากที่เก็บไฟล์สาธารณะของศูนย์ช่วยเหลือ · ไม่มี URL ที่ปลอดภัย = ไม่แสดง
    img: ({ src, alt }) => (typeof src === "string" && src ? <img src={src} alt={alt ?? ""} loading="lazy" className={styles.articleImage} /> : null),
  };
  const transform = (kind: "link" | "image") => (url: string) => articleUrl(url, appBase, kind);
  return (
    <div className={styles.prose}>
      {splitCallouts(body).map((block, i) =>
        block.kind === "callout" ? (
          <Callout key={i} type={block.type}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url, key) => transform(key === "src" ? "image" : "link")(url)}>
              {block.text}
            </ReactMarkdown>
          </Callout>
        ) : (
          <Fragment key={i}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url, key) => transform(key === "src" ? "image" : "link")(url)}>
              {block.text}
            </ReactMarkdown>
          </Fragment>
        ),
      )}
    </div>
  );
}

/** ไฮไลต์คำค้นในผลค้นหา (X2) · ใช้สี token --highlight */
export function Highlight({ text: value, terms }: { text: string; terms?: string[] }) {
  const list = (terms ?? []).filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
  if (!list.length || !value) return <>{value}</>;
  const pattern = new RegExp(`(${list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = value.split(pattern);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
