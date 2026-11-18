"use client";

import Link from "next/link";
import { Paperclip } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";
import type { AttachmentCount } from "@/lib/types";
import styles from "./attachments.module.css";

/** ส่วนของหน้างานที่คลิปพาไป: ส่วนแรกที่มีไฟล์ตามลำดับในหน้างาน */
export type FileSection = "attachments" | "unit" | "qa";
export const firstFileSection = (c: AttachmentCount): FileSection => (c.files ? "attachments" : c.unit ? "unit" : "qa");

/** เติม ?files= ให้ลิงก์เปิดงาน · Drawer อ่านค่านี้แล้วเลื่อนไปที่ส่วนไฟล์ (issue-panel.tsx) */
export function withFileSection(href: string, c: AttachmentCount) {
  return `${href}${href.includes("?") ? "&" : "?"}files=${firstFileSection(c)}`;
}

/**
 * ไอคอนคลิป + จำนวนไฟล์ของงาน (ผู้ใช้ขอ 2026-11-18) · ไม่มีไฟล์ = ไม่แสดง
 * ชี้ดูจำนวนแยกตามแหล่ง · คลิกเปิดงานแล้วเลื่อนไปที่ส่วนไฟล์
 */
export function AttachmentBadge({ counts, href, onClick, className }: {
  counts: AttachmentCount | null | undefined;
  /** ลิงก์เปิดงาน (ไม่ต้องมี files=) · ไม่ส่ง = แสดงอย่างเดียว ใช้เมื่อทั้งแถวเป็นลิงก์อยู่แล้ว (ลิงก์ซ้อนกันไม่ได้) */
  href?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
  className?: string;
}) {
  const t = useTranslations("common.attach.badge");
  if (!counts?.total) return null;
  const parts = [
    counts.files ? t("files", { count: counts.files }) : null,
    counts.unit ? t("unit", { count: counts.unit }) : null,
    counts.qa ? t("qa", { count: counts.qa }) : null,
  ].filter(Boolean).join(" · ");
  if (!href) return <span className={`${styles.badge} ${styles.still}${className ? ` ${className}` : ""}`} title={parts} aria-label={t("count", { count: counts.total, detail: parts })}><Paperclip size={13} aria-hidden="true" />{counts.total}</span>;
  const target = withFileSection(href, counts);
  return (
    <Link href={target} scroll={false} draggable={false} className={`${styles.badge}${className ? ` ${className}` : ""}`}
      title={`${parts} · ${t("open")}`} aria-label={t("label", { count: counts.total, detail: parts })}
      onClick={onClick ? (event) => onClick(event, target) : undefined}>
      <Paperclip size={13} aria-hidden="true" />{counts.total}
    </Link>
  );
}
