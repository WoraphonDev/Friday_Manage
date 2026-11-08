"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, X } from "lucide-react";

export interface PreviewFile {
  id: string;
  name: string;
  mime?: string | null;
  size?: number | null;
}

type Kind = "image" | "pdf" | "video" | "audio" | "text" | "none";
const EXT: Record<Kind, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"],
  pdf: ["pdf"],
  video: ["mp4", "webm", "mov", "m4v", "ogv"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
  text: ["txt", "csv", "json", "md", "log", "xml", "yml", "yaml", "sql", "tsv", "ini"],
  none: [],
};
/** ข้อความใหญ่กว่านี้ไม่ดึงมาแสดง (ให้ดาวน์โหลดไปเปิดเอง) */
const TEXT_LIMIT = 1024 * 1024;

export function previewKind(file: Pick<PreviewFile, "name" | "mime">): Kind {
  const mime = file.mime ?? "";
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (mime.startsWith("image/") || EXT.image.includes(ext)) return "image";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("video/") || EXT.video.includes(ext)) return "video";
  if (mime.startsWith("audio/") || EXT.audio.includes(ext)) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || EXT.text.includes(ext)) return "text";
  return "none";
}

/**
 * ดูตัวอย่างไฟล์แนบแบบป๊อปอัปเต็มจอ (ผู้ใช้ขอ 2026-11-08 · คล้ายหน้าดูไฟล์ของ Google)
 * รูป / PDF / วิดีโอ / เสียง / ข้อความ แสดงในหน้าเลย · ชนิดอื่นแสดงปุ่มดาวน์โหลด
 * base = `/api/v1/w/{ws}/projects/{key}` · filesHref = ลิงก์ไปหน้า Files ของไฟล์นั้น
 */
export function FilePreview({ files, index, base, filesHref, onIndex, onClose }: {
  files: PreviewFile[];
  index: number;
  base: string;
  filesHref?: (id: string) => string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("common.preview");
  const file = files[index];
  const kind = file ? previewKind(file) : "none";
  const download = file ? `${base}/files/${encodeURIComponent(file.id)}/download` : "";
  const [text, setText] = useState<{ id: string; body: string | null; failed?: boolean } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const many = files.length > 1;

  useEffect(() => {
    if (!file || kind !== "text" || (file.size ?? 0) > TEXT_LIMIT) return;
    let live = true;
    fetch(download, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.text();
        if (live) setText({ id: file.id, body: body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n…` : body });
      })
      .catch(() => live && setText({ id: file.id, body: null, failed: true }));
    return () => { live = false; };
  }, [file, kind, download]);

  useEffect(() => {
    if (!many) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") onIndex((index - 1 + files.length) % files.length);
      if (event.key === "ArrowRight") onIndex((index + 1) % files.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, index, files.length, onIndex]);

  if (!file) return null;
  const cannot = kind === "none" || broken === file.id || (kind === "text" && ((file.size ?? 0) > TEXT_LIMIT || (text?.id === file.id && text.failed)));
  const body = cannot ? (
    <div className="file-preview-none">
      <FileText size={48} aria-hidden="true" />
      <b>{file.name}</b>
      <p>{t("cannotPreview")}</p>
      <a className="button button-primary" href={download} download>
        <Download size={16} aria-hidden="true" /> {t("download")}
      </a>
    </div>
  ) : kind === "image" ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="file-preview-img" src={download} alt={file.name} onError={() => setBroken(file.id)} />
  ) : kind === "pdf" ? (
    <iframe className="file-preview-frame" src={`${download}?inline=1`} title={file.name} />
  ) : kind === "video" ? (
    <video className="file-preview-media" src={download} controls onError={() => setBroken(file.id)} />
  ) : kind === "audio" ? (
    <audio src={download} controls onError={() => setBroken(file.id)} />
  ) : text?.id === file.id && text.body !== null ? (
    <pre className="file-preview-text">{text.body}</pre>
  ) : (
    <p className="file-preview-loading">{t("loading")}</p>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="file-preview-overlay" />
        <Dialog.Content className="file-preview" aria-describedby={undefined}>
          <header className="file-preview-head">
            <Dialog.Title className="file-preview-title" title={file.name}>{file.name}</Dialog.Title>
            {many && <span className="file-preview-count">{t("count", { current: index + 1, total: files.length })}</span>}
            <span className="file-preview-actions">
              {filesHref && (
                <a className="file-preview-btn" href={filesHref(file.id)} aria-label={t("openInFiles")} title={t("openInFiles")}>
                  <ExternalLink size={18} aria-hidden="true" />
                </a>
              )}
              <a className="file-preview-btn" href={download} download aria-label={t("download")} title={t("download")}>
                <Download size={18} aria-hidden="true" />
              </a>
              <Dialog.Close className="file-preview-btn" aria-label={t("close")} title={t("close")}>
                <X size={20} aria-hidden="true" />
              </Dialog.Close>
            </span>
          </header>
          <div className="file-preview-stage">
            {many && (
              <button type="button" className="file-preview-nav file-preview-prev" aria-label={t("previous")} onClick={() => onIndex((index - 1 + files.length) % files.length)}>
                <ChevronLeft size={28} aria-hidden="true" />
              </button>
            )}
            <div className="file-preview-body" key={file.id}>{body}</div>
            {many && (
              <button type="button" className="file-preview-nav file-preview-next" aria-label={t("next")} onClick={() => onIndex((index + 1) % files.length)}>
                <ChevronRight size={28} aria-hidden="true" />
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** สถานะเปิด / ปิดหน้าดูตัวอย่างของรายการไฟล์ชุดหนึ่ง */
export function useFilePreview() {
  const [state, setState] = useState<{ files: PreviewFile[]; index: number } | null>(null);
  return {
    open: (files: PreviewFile[], index: number) => setState({ files, index }),
    props: state ? { files: state.files, index: state.index, onIndex: (index: number) => setState({ ...state, index }), onClose: () => setState(null) } : null,
  };
}
