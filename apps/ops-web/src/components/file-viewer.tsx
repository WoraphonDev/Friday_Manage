"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ErrorBlock, Modal } from "./kit";
import { Button, buttonClass } from "./ui";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };
const ZOOM_STEP = 1.25;

/** โหลดไฟล์แนบเป็น Blob + object URL (คืนหน่วยความจำเมื่อปิด) · ใช้ร่วมกันระหว่างภาพย่อกับหน้าต่างดูไฟล์ */
function useFileUrl(path: string) {
  const q = useQuery({ queryKey: ["ops", "file", path], queryFn: () => api.file(path), staleTime: 60_000, gcTime: 60_000, retry: false });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => (URL.revokeObjectURL(u), setUrl(null));
  }, [q.data]);
  return { ...q, url, type: q.data?.type ?? "" };
}

/**
 * หน้าต่างดูไฟล์แนบ (สลิป, 50 ทวิ) บนหน้าเดิม · ดาวน์โหลดเป็นปุ่มเสริม
 * โหลดเป็น Blob แทนการฝัง iframe ของ ops-api เพราะหลังบ้านห้ามฝังทุกหน้า (X-Frame-Options: DENY)
 */
export function FileViewer({ path, title, description, filename, aside, footer, onClose }: { path: string; title: string; description?: ReactNode; filename: string; aside?: ReactNode; footer?: ReactNode; onClose: () => void }) {
  const t = useTranslations("common.file");
  const f = useFileUrl(path);
  const ext = EXT[f.type];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} description={description} className={aside ? "dialog-file has-aside" : "dialog-file"}>
      <div className="file-body">
        <div className="file-viewer">
          {f.error ? (
            <div className="file-message">
              <ErrorBlock error={f.error} retry={() => void f.refetch()} />
            </div>
          ) : !f.url ? (
            <div className="file-message muted small" role="status">
              {t("loading")}
            </div>
          ) : f.type.startsWith("image/") ? (
            <ImageStage url={f.url} alt={title} download={<DownloadLink url={f.url} name={`${filename}.${ext ?? "bin"}`} />} />
          ) : f.type === "application/pdf" ? (
            <>
              <div className="file-tools">
                <span className="muted small">PDF</span>
                <span className="spacer" />
                <DownloadLink url={f.url} name={`${filename}.pdf`} />
              </div>
              <iframe className="file-pdf" src={f.url} title={title} />
            </>
          ) : (
            <div className="file-message">
              <FileText size={28} aria-hidden />
              <p className="muted small">{t("noPreview")}</p>
              <DownloadLink url={f.url} name={filename} />
            </div>
          )}
        </div>
        {aside && <div className="file-aside">{aside}</div>}
      </div>
      {footer && <div className="dialog-actions file-footer">{footer}</div>}
    </Modal>
  );
}

function DownloadLink({ url, name }: { url: string; name: string }) {
  const t = useTranslations("common.file");
  return (
    <a className={buttonClass("secondary", "small")} href={url} download={name}>
      <Download size={14} /> {t("download")}
    </a>
  );
}

/** ภาพ: พอดีกรอบเป็นค่าเริ่มต้น · ซูม / หมุนทีละ 90° · ขนาดกล่องสลับตามการหมุนเพื่อให้เลื่อนดูได้ครบ */
function ImageStage({ url, alt, download }: { url: string; alt: string; download: ReactNode }) {
  const t = useTranslations("common.file");
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth - 32, h: el.clientHeight - 32 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const turned = rotation % 180 !== 0;
  const bw = natural ? (turned ? natural.h : natural.w) : 0;
  const bh = natural ? (turned ? natural.w : natural.h) : 0;
  const fit = natural && box.w > 0 && box.h > 0 ? Math.min(box.w / bw, box.h / bh, 1) : 1;
  const scale = zoom ?? fit;
  const step = (dir: 1 | -1) => setZoom(Math.min(4, Math.max(0.1, (dir > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP))));
  return (
    <>
      <div className="file-tools">
        <Button variant="ghost" size="icon" aria-label={t("zoomOut")} onClick={() => step(-1)} disabled={!natural}>
          <ZoomOut size={16} />
        </Button>
        <span className="file-zoom" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <Button variant="ghost" size="icon" aria-label={t("zoomIn")} onClick={() => step(1)} disabled={!natural}>
          <ZoomIn size={16} />
        </Button>
        <Button variant="ghost" size="small" onClick={() => setZoom(null)} disabled={zoom === null}>
          <Maximize2 size={14} /> {t("fit")}
        </Button>
        <Button variant="ghost" size="small" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <RotateCw size={14} /> {t("rotate")}
        </Button>
        <span className="spacer" />
        {download}
      </div>
      <div className="file-stage" ref={stage}>
        <div className="file-canvas" style={natural ? { width: bw * scale, height: bh * scale } : undefined}>
          {/* blob URL ของไฟล์ลูกค้า จึงใช้ img ธรรมดา ไม่ผ่าน next/image */}
          <img
            src={url}
            alt={alt}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={natural ? { width: natural.w * scale, height: natural.h * scale, transform: `translate(-50%, -50%) rotate(${rotation}deg)` } : { opacity: 0 }}
          />
        </div>
      </div>
    </>
  );
}

/** ภาพย่อของไฟล์แนบในแผงตัดสิน · กดแล้วเปิด FileViewer */
export function FileThumb({ path, label, hint, onOpen }: { path: string; label: string; hint: string; onOpen: () => void }) {
  const f = useFileUrl(path);
  return (
    <button type="button" className="file-thumb" onClick={onOpen}>
      <span className="file-thumb-img" aria-hidden>
        {f.url && f.type.startsWith("image/") ? (
          // blob URL ใช้ img ธรรมดา
          <img src={f.url} alt="" />
        ) : (
          <FileText size={22} />
        )}
      </span>
      <span>
        <b>{label}</b>
        <br />
        <span className="muted small">{hint}</span>
      </span>
    </button>
  );
}
