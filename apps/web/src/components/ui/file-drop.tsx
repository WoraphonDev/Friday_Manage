"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { Upload, X } from "lucide-react";
import { formatBytes } from "@/features/trash/format";

/**
 * ลากไฟล์จากเครื่องมาวางในกล่อง (ผู้ใช้ขอ 2026-11-17 · ลากรูปหลายไฟล์จากโฟลเดอร์ทีเดียว)
 * ตอบเฉพาะการลาก "ไฟล์" · การลากการ์ด / แถวในบอร์ดไม่มี Files ใน types จึงไม่ทำให้กรอบขึ้น
 */
const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(0);
  // dragenter / dragleave ยิงทุกครั้งที่ผ่านลูกในกล่อง · นับชั้นไว้ กรอบจึงไม่กะพริบ
  const depth = useRef(0);
  useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setDragging(0);
    }
  }, [enabled]);
  if (!enabled) return { dragging: 0, bind: {} };
  return {
    /** 0 = ไม่ได้ลาก · มากกว่า 0 = จำนวนไฟล์ที่ลากมา (Safari ไม่บอกจำนวน จึงเป็น 1 ขั้นต่ำ) */
    dragging,
    bind: {
      onDragEnter(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(Math.max(1, event.dataTransfer.items?.length ?? 1));
      },
      onDragOver(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(event: DragEvent) {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(0);
      },
      onDrop(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setDragging(0);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length) onFiles(files);
      },
    },
  };
}

/** กรอบม่วงทับกล่องตอนลากไฟล์มา · กล่องแม่ต้องเป็น position: relative */
export function DropOverlay({ count, hint }: { count: number; hint?: string }) {
  const t = useTranslations("common.attach");
  if (!count) return null;
  return (
    <div className="file-drop-overlay" aria-hidden="true">
      <Upload size={22} />
      <b>{count > 1 ? t("dropCount", { count }) : t("drop")}</b>
      {hint && <small>{hint}</small>}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * ไฟล์จากการวาง (⌘V / Ctrl+V) · ภาพหน้าจอในคลิปบอร์ดชื่อ image.png ทุกรูป จึงตั้งชื่อตามเวลาให้แยกกันได้
 * ถ้าคลิปบอร์ดมีข้อความด้วย (เช่น คัดลอกเซลล์ Excel ซึ่งแนบภาพของเซลล์มาด้วย) ให้วางเป็นข้อความตามปกติ
 */
export function pastedFiles(event: ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data?.files?.length || data.getData("text/plain")) return [];
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const files = Array.from(data.files).map((file, index) => {
    if (!/^image\.\w+$/.test(file.name)) return file;
    const ext = file.name.split(".").pop();
    return new File([file], `screenshot-${stamp}${index ? `-${index + 1}` : ""}.${ext}`, { type: file.type, lastModified: file.lastModified });
  });
  event.preventDefault();
  return files;
}

export const isImageFile = (file: { name: string; mime?: string | null; type?: string }) =>
  (file.mime ?? file.type ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name);

/** URL รูปย่อของไฟล์ในเครื่องที่ยังไม่ได้อัปโหลด · คืนหน่วยความจำเมื่อรายการเปลี่ยนหรือเลิกใช้ */
export function useFileThumbs(files: File[]) {
  const [urls, setUrls] = useState(() => new Map<File, string>());
  useEffect(() => {
    const next = new Map<File, string>();
    for (const file of files) if (isImageFile(file)) next.set(file, URL.createObjectURL(file));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  return urls;
}

export interface AttachmentRow {
  key: string;
  name: string;
  size?: number | null;
  /** บรรทัดรองแทนขนาดไฟล์ เช่น ผู้อัปโหลด · วันที่ */
  meta?: string;
  /** URL รูปย่อ · ไม่มี = แสดงนามสกุลไฟล์แทน */
  thumb?: string | null;
  /** undefined = อัปโหลดเสร็จแล้ว · null = รอคิว · 0–1 = กำลังอัปโหลด */
  progress?: number | null;
  onOpen?: () => void;
  onRemove?: () => void;
}

function Thumb({ row }: { row: AttachmentRow }) {
  const [broken, setBroken] = useState(false);
  const ext = (row.name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
  if (row.thumb && !broken) return <img className="attach-thumb" src={row.thumb} alt="" onError={() => setBroken(true)} />;
  return <span className="attach-thumb attach-thumb-ext">{ext || "FILE"}</span>;
}

/** รายการไฟล์ที่แนบ: รูปย่อ ชื่อ ขนาด/ความคืบหน้า และปุ่มเอาออกทีละไฟล์ */
export function AttachmentList({ rows, label }: { rows: AttachmentRow[]; label?: string }) {
  const t = useTranslations("common.attach");
  if (!rows.length) return null;
  return (
    <ul className="attach-list" aria-label={label}>
      {rows.map((row) => {
        const uploading = row.progress !== undefined;
        const name = <b>{row.name}</b>;
        return (
          <li key={row.key} className="attach-item" data-uploading={uploading || undefined}>
            <Thumb row={row} />
            <span className="attach-meta">
              {row.onOpen ? (
                <button type="button" className="attach-open" onClick={row.onOpen} aria-label={t("open", { name: row.name })}>
                  {name}
                </button>
              ) : (
                name
              )}
              {row.progress === null ? (
                <small>{t("queued")}</small>
              ) : uploading ? (
                <span className="attach-bar" role="progressbar" aria-label={t("uploadingName", { name: row.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((row.progress ?? 0) * 100)}>
                  <i style={{ width: `${Math.round((row.progress ?? 0) * 100)}%` }} />
                </span>
              ) : (
                (row.meta || row.size != null) && <small>{row.meta || formatBytes(row.size!)}</small>
              )}
            </span>
            {row.onRemove && (
              <button type="button" className="attach-remove" onClick={row.onRemove} aria-label={t(uploading ? "cancel" : "remove", { name: row.name })}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
