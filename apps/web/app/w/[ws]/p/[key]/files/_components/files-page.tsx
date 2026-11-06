"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Upload, X } from "lucide-react";
import { Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Forbidden, Input, LoadingState, Select, useToast } from "@/components/ui";
import { useWorkspace } from "@/components/shell/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import type { Permissions, Person } from "@/lib/types";
import type { Attachment, FileDetail, FileItem, FileList, Folder, FolderList, UploadTarget } from "./types";
import styles from "./files.module.css";

/** ขีดจำกัดเดียวกับ API (413 file_too_large) · ตรวจก่อนเพื่อไม่ต้องขอ URL เปล่า ๆ */
export const MAX_BYTES = 100 * 1024 * 1024;
type Sort = "newest" | "oldest" | "name" | "size";
/** all / recent / tasks / k:{ประเภท} = มุมมองรวมทุกโฟลเดอร์ (Canvas Files) · root = รากของโปรเจกต์ · trash = ถังขยะ · อื่น ๆ = id ของโฟลเดอร์ */
type Place = "all" | "recent" | "tasks" | `k:${string}` | "root" | "trash" | string;
const VIRTUAL = (p: string) => p === "all" || p === "recent" || p === "tasks" || p.startsWith("k:");
const KIND_GROUPS = ["doc", "design", "image", "sheet", "other"] as const;
interface UploadJob {
  id: number;
  name: string;
  size: number;
  loaded: number;
  error?: string;
  abort?: () => void;
}

export function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const LINK_EXT: Record<string, string> = { figma: "FIG", google_drive: "DRIVE", notion: "NOTION", other: "LINK" };
/** ป้ายนามสกุลแบบ Canvas (PDF, XLSX, FIG …) และกลุ่มสีของป้าย */
export function extOf(f: Pick<FileItem, "name" | "kind" | "linkProvider">) {
  if (f.kind === "link") return { label: LINK_EXT[f.linkProvider ?? "other"] ?? "LINK", tone: f.linkProvider === "figma" ? "fig" : "link" };
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  const tone = ext === "pdf" ? "pdf" : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "png" : ["xls", "xlsx", "csv"].includes(ext) ? "xlsx" : ["doc", "docx", "txt", "md"].includes(ext) ? "docx" : ["mp4", "mov", "webm"].includes(ext) ? "mp4" : "other";
  return { label: (ext || "FILE").slice(0, 5).toUpperCase(), tone };
}
type Kind = "doc" | "sheet" | "image" | "video" | "design" | "link" | "other";
export function kindOf(f: Pick<FileItem, "name" | "kind" | "linkProvider" | "mime">): Kind {
  if (f.kind === "link") return f.linkProvider === "figma" ? "design" : "link";
  const tone = extOf(f).tone;
  if (tone === "pdf" || tone === "docx") return "doc";
  if (tone === "xlsx") return "sheet";
  if (tone === "png" || f.mime?.startsWith("image/")) return "image";
  if (tone === "mp4" || f.mime?.startsWith("video/")) return "video";
  return "other";
}

/** กลุ่มประเภทในเมนูซ้ายตาม Canvas: Documents, Designs, Images, Spreadsheets, Others */
export function groupOf(f: Pick<FileItem, "name" | "kind" | "linkProvider" | "mime">): (typeof KIND_GROUPS)[number] {
  const k = kindOf(f);
  return k === "doc" ? "doc" : k === "design" ? "design" : k === "image" ? "image" : k === "sheet" ? "sheet" : "other";
}

/** เรียงโฟลเดอร์เป็นต้นไม้ (แม่ก่อนลูก) พร้อมระดับความลึกสำหรับเยื้อง */
export function flattenFolders(items: Folder[]) {
  const ids = new Set(items.map((f) => f.id));
  const kids = new Map<string | null, Folder[]>();
  for (const f of items) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), f]);
  }
  const out: (Folder & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of kids.get(parent) ?? []) {
      out.push({ ...f, depth });
      if (depth < 20) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * ที่เก็บในเครื่อง (dev / test) ออก URL ไปที่ origin ของ API ตรง ๆ ซึ่งไม่เปิด CORS ให้เว็บ
 * จึงส่งผ่าน proxy `/api/v1` ของเว็บเอง · S3 ใช้ URL ตามที่ได้ (CORS ตั้งที่ bucket)
 */
export function uploadUrl(target: Pick<UploadTarget, "url" | "storage">) {
  if (target.storage !== "local") return target.url;
  try {
    const u = new URL(target.url, "http://local");
    if (u.pathname.startsWith("/api/v1/storage/")) return `${u.pathname}${u.search}`;
  } catch {
    // URL แปลก ๆ ใช้ตามเดิม
  }
  return target.url;
}

/** PUT ไฟล์ไปที่ URL ที่ API ออกให้ · ใช้ XHR เพราะ fetch ยังไม่มี progress ของการอัปโหลด */
export function putFile(target: Pick<UploadTarget, "method" | "url" | "headers">, file: Blob, onProgress: (loaded: number) => void, register: (abort: () => void) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "upload_failed", "")));
    xhr.onerror = () => reject(new ApiError(0, "network_error", ""));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    register(() => xhr.abort());
    xhr.send(file);
  });
}

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function FilesPage({ ws, projectKey }: { ws: string; projectKey: string }) {
  const t = useTranslations("files");
  const { me } = useWorkspace();
  const year = me.yearFormat;
  const cache = useQueryClient();
  const toast = useToast();
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const pageHref = `/w/${encodeURIComponent(ws)}/p/${encodeURIComponent(projectKey)}/files`;
  const [place, setPlace] = useState<Place>("all");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [uploader, setUploader] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [view, setView] = useState<"list" | "grid">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [dialog, setDialog] = useState<null | "folder" | "renameFolder" | "link" | "rename" | "move" | "attach">(null);
  const [evidence, setEvidence] = useState<{ file: FileItem; refs: string[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const h = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(h);
  }, [qInput]);

  const perms = useQuery({ queryKey: queryKeys.permissions(ws, projectKey), queryFn: () => api.get<Permissions>(`${base}/my-permissions`) });
  const has = (p: string) => !!perms.data?.permissions.includes(p);
  const canUpload = has("file.upload");
  const canDelete = has("file.delete");
  const canTrash = has("project.trash");
  const allowed = !!perms.data && !perms.data.guestViewer;

  const folders = useQuery({ queryKey: ["files", ws, projectKey, "folders"], queryFn: () => api.get<FolderList>(`${base}/folders`), enabled: allowed });
  const params = new URLSearchParams({ sort });
  if (place === "trash") params.set("trashed", "true");
  else if (q) params.set("q", q);
  else params.set("folder", VIRTUAL(place) ? "root" : place);
  if (uploader) params.set("uploader", uploader);
  const list = useQuery({ queryKey: ["files", ws, projectKey, "list", params.toString()], queryFn: () => api.get<FileList>(`${base}/files?${params}`), enabled: allowed });
  // ไฟล์ทุกโฟลเดอร์สำหรับ All files / Recent / From tasks / ตามประเภท · API ไม่มีตัวเลือก "ทั้งหมด" จึงรวมรากกับทุกโฟลเดอร์
  const folderIds = (folders.data?.items ?? []).map((f) => f.id);
  const allFiles = useQuery({
    queryKey: ["files", ws, projectKey, "all", sort, uploader, folderIds.join(",")],
    queryFn: async () => {
      const lists = await Promise.all(["root", ...folderIds].map((id) => api.get<FileList>(`${base}/files?sort=${sort}&folder=${encodeURIComponent(id)}${uploader ? `&uploader=${encodeURIComponent(uploader)}` : ""}`)));
      const items = [...new Map(lists.flatMap((l) => l.items).map((f) => [f.id, f])).values()];
      const by: Record<Sort, (a: FileItem, b: FileItem) => number> = {
        newest: (a, b) => b.updatedAt.localeCompare(a.updatedAt), oldest: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
        name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
      };
      return { items: items.sort(by[sort]), totalBytes: lists.reduce((n, l) => n + l.totalBytes, 0) };
    },
    enabled: allowed && !!folders.data,
  });
  // จำนวนในถังขยะ (เฉพาะคนที่กู้คืนได้ · คนอื่นได้ 403)
  const trash = useQuery({ queryKey: ["files", ws, projectKey, "list", "sort=newest&trashed=true"], queryFn: () => api.get<FileList>(`${base}/files?sort=newest&trashed=true`), enabled: allowed && canTrash });

  // รายชื่อผู้อัปโหลดสะสมจากทุกหน้าที่เปิด · API ไม่มีรายการผู้อัปโหลดแยก
  useEffect(() => {
    const found = list.data?.items.map((f) => f.uploader).filter((p): p is Person => !!p) ?? [];
    if (found.length) setPeople((cur) => { const ids = new Set(cur.map((p) => p.id)); const add = found.filter((p) => !ids.has(p.id) && (ids.add(p.id), true)); return add.length ? [...cur, ...add] : cur; });
  }, [list.data]);

  const tree = useMemo(() => flattenFolders(folders.data?.items ?? []), [folders.data]);
  const items = useMemo(() => {
    if (!VIRTUAL(place) || q) return list.data?.items ?? [];
    const all = allFiles.data?.items ?? [];
    if (place === "recent") return [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
    if (place === "tasks") return all.filter((f) => f.attachments > 0);
    if (place.startsWith("k:")) return all.filter((f) => groupOf(f) === place.slice(2));
    return all;
  }, [list.data, allFiles.data, place, q]);
  const inTrash = place === "trash";
  const current = items.find((f) => f.id === selectedId) ?? items[0];
  const detail = useQuery({ queryKey: ["files", ws, projectKey, "detail", current?.id], queryFn: () => api.get<FileDetail>(`${base}/files/${current!.id}`), enabled: !!current && !inTrash });
  const folderId = place !== "root" && place !== "trash" && !VIRTUAL(place) ? place : null;
  const folderName = tree.find((f) => f.id === folderId)?.name;
  const reload = () => cache.invalidateQueries({ queryKey: ["files", ws, projectKey] });

  function go(next: Place) {
    setPlace(next);
    setSelectedId(null);
    setQInput("");
    setQ("");
  }

  async function upload(file: File, versionOf?: FileItem) {
    if (file.size > MAX_BYTES) { toast({ message: t("tooLarge", { name: file.name }) }); return; }
    const id = ++seq.current;
    const patch = (p: Partial<UploadJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));
    setJobs((js) => [...js, { id, name: versionOf?.name ?? file.name, size: file.size, loaded: 0 }]);
    try {
      const target = await api.post<UploadTarget>(`${base}/files/upload-url`, { name: file.name, size: file.size, mime: file.type || undefined, folderId: versionOf ? undefined : folderId, fileId: versionOf?.id });
      await putFile({ ...target, url: uploadUrl(target) }, file, (loaded) => patch({ loaded }), (abort) => patch({ abort }));
      if (versionOf) await api.post(`${base}/files/${versionOf.id}/versions`, { uploadToken: target.uploadToken });
      else await api.post(`${base}/files`, { uploadToken: target.uploadToken });
      setJobs((js) => js.filter((j) => j.id !== id));
      toast({ message: versionOf ? t("versionUploaded", { name: versionOf.name }) : t("uploaded", { name: file.name }) });
      await reload();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") { setJobs((js) => js.filter((j) => j.id !== id)); return; }
      patch({ error: e instanceof ApiError && e.code === "upload_failed" ? t("uploadFailed") : message(e, t("uploadFailed")), abort: undefined });
    }
  }
  const uploadAll = (files: FileList_ | null) => { for (const f of Array.from(files ?? [])) void upload(f); };

  async function remove(file: FileItem, confirm = false) {
    try {
      const r = await api.delete<{ restorableUntil: string }>(`${base}/files/${file.id}`, { body: { confirm } });
      setSelectedId(null);
      toast({ message: t("deleted", { name: file.name, date: formatDate(r.restorableUntil, year) }), undo: canTrash ? () => restore(file) : undefined });
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "file_is_evidence") {
        const refs = ((e.details.evidence as { targetType: string; ref: string }[] | undefined) ?? []).map((x) => (x.targetType === "bug" ? t("evidenceBug", { ref: x.ref }) : t("evidenceRun", { ref: x.ref })));
        setEvidence({ file, refs });
        return;
      }
      toast({ message: message(e, t("failed")) });
    }
  }
  async function restore(file: FileItem) {
    try {
      await api.post(`${base}/files/${file.id}/restore`);
      toast({ message: t("restored", { name: file.name }) });
    } catch (e) {
      toast({ message: e instanceof ApiError && e.code === "restore_expired" ? t("restoreExpired") : message(e, t("failed")) });
    }
    await reload();
  }
  async function detach(file: FileItem, a: Attachment) {
    try {
      await api.delete(`${base}/files/${file.id}/attachments`, { body: { targetType: a.targetType, target: a.targetType === "project" ? undefined : a.target } });
      toast({ message: t("detached", { target: a.target }) });
    } catch (e) {
      toast({ message: message(e, t("failed")) });
    }
    await reload();
  }
  async function copyLink(file: FileItem) {
    const url = file.kind === "link" && file.linkUrl ? file.linkUrl : new URL(`/api/v1${base}/files/${file.id}/download`, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      toast({ message: t("copied") });
    } catch {
      toast({ message: url });
    }
  }
  async function deleteFolder(id: string) {
    try {
      await api.delete(`${base}/folders/${id}`);
      const parent = tree.find((f) => f.id === id)?.parentId ?? "root";
      toast({ message: t("folderDeleted") });
      go(parent);
    } catch (e) {
      toast({ message: message(e, t("failed")) });
    }
    await reload();
  }

  if (perms.isPending || (allowed && (folders.isPending || list.isPending) && !list.error && !folders.error)) return <div className={styles.page}><LoadingState /></div>;
  if (perms.data?.guestViewer) return <div className={styles.page}><Forbidden /></div>;
  const err = perms.error ?? folders.error ?? list.error;
  if (err) return <div className={styles.page}>{err instanceof ApiError && err.status === 403 ? <Forbidden /> : <ErrorState error={err} retry={() => { void folders.refetch(); void list.refetch(); }} />}</div>;

  const data = list.data!;
  const title = inTrash ? t("trash") : q ? t("searchResults", { q }) : VIRTUAL(place) ? t(place.startsWith("k:") ? `typeGroups.${place.slice(2)}` : `places.${place}`) : (folderName ?? t("root"));
  const all = allFiles.data?.items ?? [];
  const trashCount = trash.data?.items.length ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.body}>
        <nav className={`${styles.card} ${styles.side}`} aria-label={t("foldersNav")}>
          {/* Canvas Files: All files, Recent, From tasks · ตามประเภท · Folders */}
          <FolderButton on={place === "all" && !q} onClick={() => go("all")} count={all.length}>{t("places.all")}</FolderButton>
          <FolderButton on={place === "recent" && !q} onClick={() => go("recent")} count={Math.min(20, all.length)}>{t("places.recent")}</FolderButton>
          <FolderButton on={place === "tasks" && !q} onClick={() => go("tasks")} count={all.filter((f) => f.attachments > 0).length}>{t("places.tasks")}</FolderButton>
          <div className={styles.fsec}>{t("byType")}</div>
          {KIND_GROUPS.map((k) => <FolderButton key={k} on={place === `k:${k}` && !q} onClick={() => go(`k:${k}`)} count={all.filter((f) => groupOf(f) === k).length}>{t(`typeGroups.${k}`)}</FolderButton>)}
          <div className={styles.fsec}>{t("folders")}</div>
          <FolderButton on={place === "root" && !q} onClick={() => go("root")} count={folders.data?.rootFileCount}>{t("root")}</FolderButton>
          {tree.map((f) => (
            <FolderButton key={f.id} on={place === f.id && !q} onClick={() => go(f.id)} count={f.fileCount} depth={f.depth}>{f.name}</FolderButton>
          ))}
          {!tree.length && <div className={`${styles.muted} ${styles.hint}`}>{t("noFolders")}</div>}
          {canUpload && <button type="button" className={styles.fo} style={{ color: "var(--primary)" }} onClick={() => setDialog("folder")}>{t("newFolder")}</button>}
          <div className={styles.sideFoot}>
            <div className={styles.line}><span className={styles.muted}>{t("totalHere")}</span><b>{formatBytes(allFiles.data?.totalBytes ?? data.totalBytes)}</b></div>
            {canTrash && (
              <button type="button" className={`${styles.fo} ${place === "trash" ? styles.on : ""}`} aria-pressed={inTrash} style={{ padding: 0, marginTop: 8 }} onClick={() => go("trash")}>
                {t("trash")} <span className={styles.c}>{t("trashCount", { count: trashCount })}</span>
              </button>
            )}
          </div>
        </nav>

        <div className={styles.main}>
          {canUpload && !inTrash && (
            <div
              className={`${styles.drop} ${dragging ? styles.dragging : ""}`}
              data-testid="dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); uploadAll(e.dataTransfer.files); }}
            >
              <Upload size={34} color="var(--primary)" aria-hidden="true" />
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontWeight: 600 }}>{t("dropTitle")} <button type="button" className={styles.linkBtn} onClick={() => fileInput.current?.click()}>{t("choose")}</button></div>
                <div className={`${styles.muted} ${styles.small}`}>{t("dropHint")}</div>
              </div>
              <Button onClick={() => setDialog("link")}>{t("addLink")}</Button>
              <input ref={fileInput} type="file" multiple hidden aria-label={t("fileInput")} onChange={(e) => { uploadAll(e.target.files); e.target.value = ""; }} />
            </div>
          )}

          {jobs.map((j) => (
            <div key={j.id} className={`${styles.card} ${styles.job}`} role="status" aria-label={t("uploadingName", { name: j.name })}>
              <span className={`${styles.ext} ${styles[`x-${extOf({ name: j.name, kind: "upload", linkProvider: null }).tone}`]}`}>{extOf({ name: j.name, kind: "upload", linkProvider: null }).label}</span>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div className={styles.line}>
                  <b className={styles.ellipsis}>{j.name}</b>
                  <span className={j.error ? styles.err : styles.muted}>{j.error ?? t("uploading", { pct: j.size ? Math.round((j.loaded / j.size) * 100) : 0, loaded: formatBytes(j.loaded), size: formatBytes(j.size) })}</span>
                </div>
                <div className={styles.bar}><div style={{ width: `${j.size ? Math.round((j.loaded / j.size) * 100) : 0}%` }} /></div>
              </div>
              {j.error ? <Button size="small" onClick={() => setJobs((js) => js.filter((x) => x.id !== j.id))}>{t("dismiss")}</Button> : <Button size="small" disabled={!j.abort} onClick={() => j.abort?.()}>{t("cancel")}</Button>}
            </div>
          ))}

          {folderId && !q && (
            <nav aria-label={t("breadcrumb")} className={`${styles.small} ${styles.crumbs}`}>
              <button type="button" className={styles.linkBtn} onClick={() => go("root")}>{t("root")}</button>
              {data.breadcrumb.map((c, i) => (
                <span key={c.id}> / {i < data.breadcrumb.length - 1 ? <button type="button" className={styles.linkBtn} onClick={() => go(c.id)}>{c.name}</button> : <span aria-current="page">{c.name}</span>}</span>
              ))}
            </nav>
          )}

          <div className={styles.toolbar}>
            <div className={styles.row}>
              <h2 className={styles.h2}>{title} <span className={styles.muted} style={{ fontWeight: 500 }}>· {t("count", { count: items.length })}</span></h2>
              {folderId && !q && canUpload && (
                <>
                  <Button size="small" variant="ghost" onClick={() => setDialog("renameFolder")}>{t("renameFolder")}</Button>
                  <Button size="small" variant="ghost" onClick={() => void deleteFolder(folderId)}>{t("deleteFolder")}</Button>
                </>
              )}
            </div>
            <div className={styles.row}>
              {!inTrash && <input className={`input ${styles.search}`} type="search" placeholder={t("search")} aria-label={t("search")} value={qInput} onChange={(e) => setQInput(e.target.value)} />}
              <Select size="small" prefix={t("uploader")} aria-label={t("uploader")} value={uploader} onChange={(e) => setUploader(e.target.value)}>
                <option value="">{t("everyone")}</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </Select>
              <Select size="small" prefix={t("sort")} aria-label={t("sort")} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {(["newest", "oldest", "name", "size"] as const).map((s) => <option key={s} value={s}>{t(`sorts.${s}`)}</option>)}
              </Select>
              <div className={styles.seg} role="group" aria-label={t("view")}>
                <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
                <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")}>Grid</button>
              </div>
              {canUpload && !inTrash && <Button variant="primary" onClick={() => fileInput.current?.click()}>{t("upload")}</Button>}
            </div>
          </div>

          {!items.length ? (
            <section className={styles.card}>
              <EmptyState title={inTrash ? t("emptyTrash") : q || uploader ? t("emptyFiltered") : t("empty")} description={inTrash ? t("emptyTrashHint", { days: 30 }) : canUpload && !q ? t("emptyHint") : t("emptyFilteredHint")} />
            </section>
          ) : view === "list" ? (
            <div className={styles.card} style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 860 }} role="table" aria-label={title}>
                <div className={`${styles.fr} ${styles.h}`} role="row">
                  {(["name", "linked", "uploader", inTrash ? "deletedAt" : "updated", "size", "ver"] as const).map((c) => <div key={c} role="columnheader">{t(`cols.${c}`)}</div>)}
                  <div role="columnheader" aria-label={t("actions")} />
                </div>
                {items.map((f) => (
                  <div key={f.id} role="row" data-testid={`file-${f.name}`} className={`${styles.fr} ${!inTrash && current?.id === f.id ? styles.sel : ""}`}>
                    <div role="cell" className={styles.nameCell}>
                      <Ext f={f} />
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <button type="button" className={styles.fn} aria-pressed={!inTrash && current?.id === f.id} onClick={() => setSelectedId(f.id)} disabled={inTrash}>{f.name}</button>
                        <span className={`${styles.muted} ${styles.small}`}>{t(`kinds.${kindOf(f)}`, { provider: t(`providers.${f.linkProvider ?? "other"}`) })}</span>
                      </div>
                    </div>
                    <div role="cell" className={styles.ellipsis} style={{ fontSize: 13 }}>
                      {f.evidence && <Badge tone="amber">{t("evidence")}</Badge>} {f.attachments ? t("linkedCount", { count: f.attachments }) : <span className={styles.muted}>—</span>}
                    </div>
                    <div role="cell" className={styles.who}>{f.uploader ? <><Avatar size="small" person={f.uploader} />{f.uploader.displayName}</> : "—"}</div>
                    <div role="cell" className={styles.muted} style={{ fontSize: 13 }}>{formatDate(inTrash ? f.deletedAt : f.updatedAt, year)}</div>
                    <div role="cell" className={styles.muted} style={{ fontSize: 13 }}>{f.kind === "link" ? t("link") : formatBytes(f.size)}</div>
                    <div role="cell">{f.versionNo ? <Badge>v{f.versionNo}</Badge> : <span className={styles.muted}>—</span>}</div>
                    <div role="cell">
                      {inTrash && canTrash ? <Button size="small" onClick={() => void restore(f)}>{t("restore")}</Button> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.grid}>
              {items.map((f) => (
                <button key={f.id} type="button" className={`${styles.gc} ${!inTrash && current?.id === f.id ? styles.gsel : ""}`} aria-pressed={!inTrash && current?.id === f.id} onClick={() => (inTrash ? undefined : setSelectedId(f.id))}>
                  <div className={`${styles.thumb} ${styles[`x-${extOf(f).tone}`]}`}>{extOf(f).label}</div>
                  <div className={styles.gbody}>
                    <span className={styles.ellipsis} style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</span>
                    <span className={`${styles.muted} ${styles.small} ${styles.ellipsis}`}>{t(`kinds.${kindOf(f)}`, { provider: t(`providers.${f.linkProvider ?? "other"}`) })}</span>
                    <span className={`${styles.muted} ${styles.small}`}>{f.uploader?.displayName ?? "—"} · {formatDate(inTrash ? f.deletedAt : f.updatedAt, year)} · {f.kind === "link" ? t("link") : formatBytes(f.size)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {inTrash && canTrash && items.length > 0 && view === "grid" && (
            <div className={styles.row}>{items.map((f) => <Button key={f.id} size="small" onClick={() => void restore(f)}>{t("restoreName", { name: f.name })}</Button>)}</div>
          )}

          {!inTrash && current && (
            <DetailPanel
              file={current} detail={detail.data} detailError={detail.error} base={base} pageHref={pageHref} year={year}
              canUpload={canUpload} canDelete={canDelete}
              onNewVersion={() => versionInput.current?.click()}
              onCopy={() => void copyLink(current)}
              onRename={() => setDialog("rename")}
              onMove={() => setDialog("move")}
              onDelete={() => void remove(current)}
              onAttach={() => setDialog("attach")}
              onDetach={(a) => void detach(current, a)}
            />
          )}
          <input ref={versionInput} type="file" hidden aria-label={t("versionInput")} onChange={(e) => { const f = e.target.files?.[0]; if (f && current) void upload(f, current); e.target.value = ""; }} />
        </div>
      </div>

      {dialog === "folder" && (
        <PromptDialog title={t("newFolderTitle")} label={t("folderName")} submit={t("create")} onClose={() => setDialog(null)} onSubmit={async (name) => {
          const f = await api.post<Folder>(`${base}/folders`, { name, parentId: folderId });
          toast({ message: t("folderCreated", { name }) });
          await reload();
          go(f.id);
        }} />
      )}
      {dialog === "renameFolder" && folderId && (
        <PromptDialog title={t("renameFolder")} label={t("folderName")} initial={folderName} submit={t("save")} onClose={() => setDialog(null)} onSubmit={async (name) => {
          await api.request(`${base}/folders/${folderId}`, { method: "PATCH", body: { name } });
          await reload();
        }} />
      )}
      {dialog === "rename" && current && (
        <PromptDialog title={t("renameTitle")} label={t("fileName")} initial={current.name} submit={t("save")} onClose={() => setDialog(null)} onSubmit={async (name) => {
          await api.request(`${base}/files/${current.id}`, { method: "PATCH", body: { name } });
          toast({ message: t("renamed", { name }) });
          await reload();
        }} />
      )}
      {dialog === "attach" && current && (
        <PromptDialog title={t("attachTitle")} label={t("issueKey")} placeholder={`${projectKey}-1`} submit={t("attach")} onClose={() => setDialog(null)} onSubmit={async (key) => {
          const r = await api.post<{ attached: boolean }>(`${base}/files/${current.id}/attachments`, { targetType: "issue", target: key.toUpperCase() });
          toast({ message: r.attached ? t("attached", { key: key.toUpperCase() }) : t("alreadyAttached", { key: key.toUpperCase() }) });
          await reload();
        }} />
      )}
      {dialog === "move" && current && (
        <MoveDialog file={current} tree={tree} onClose={() => setDialog(null)} onSubmit={async (target) => {
          await api.request(`${base}/files/${current.id}`, { method: "PATCH", body: { folderId: target } });
          toast({ message: t("moved", { name: current.name, folder: tree.find((f) => f.id === target)?.name ?? t("root") }) });
          setSelectedId(null);
          await reload();
        }} />
      )}
      {dialog === "link" && (
        <LinkDialog onClose={() => setDialog(null)} onSubmit={async (linkUrl, name) => {
          await api.post(`${base}/files`, { linkUrl, name: name || undefined, folderId });
          toast({ message: t("linkAdded") });
          await reload();
        }} />
      )}
      {evidence && (
        <ConfirmDialog open title={t("evidenceTitle")} description={`${t("evidenceDescription")} ${evidence.refs.join(", ")}`} confirmLabel={t("deleteAnyway")}
          onOpenChange={(o) => { if (!o) setEvidence(null); }}
          onConfirm={async () => { const f = evidence.file; setEvidence(null); await remove(f, true); }} />
      )}
    </div>
  );
}

type FileList_ = globalThis.FileList;

function FolderButton({ on, onClick, count, depth = 0, children }: { on: boolean; onClick: () => void; count?: number; depth?: number; children: ReactNode }) {
  return (
    <button type="button" className={`${styles.fo} ${on ? styles.on : ""}`} aria-pressed={on} onClick={onClick} style={{ paddingLeft: 10 + depth * 14 }}>
      <span className={styles.ellipsis}>{children}</span>
      {count !== undefined && <span className={styles.c}>{count}</span>}
    </button>
  );
}

function Ext({ f }: { f: FileItem }) {
  const e = extOf(f);
  return <span className={`${styles.ext} ${styles[`x-${e.tone}`]}`} aria-hidden="true">{e.label}</span>;
}

function DetailPanel({ file, detail, detailError, base, pageHref, year, canUpload, canDelete, onNewVersion, onCopy, onRename, onMove, onDelete, onAttach, onDetach }: {
  file: FileItem; detail?: FileDetail; detailError: unknown; base: string; pageHref: string; year: "BE" | "CE"; canUpload: boolean; canDelete: boolean;
  onNewVersion: () => void; onCopy: () => void; onRename: () => void; onMove: () => void; onDelete: () => void; onAttach: () => void; onDetach: (a: Attachment) => void;
}) {
  const t = useTranslations("files");
  const e = extOf(file);
  const download = `/api/v1${base}/files/${file.id}/download`;
  const label = (a: Attachment) => (a.targetType === "issue" ? a.target : a.targetType === "project" ? t("targets.project") : a.targetType === "requirement" ? a.target : t(`targets.${a.targetType}`));
  return (
    <section className={`${styles.card} ${styles.detail}`} aria-label={t("detail")}>
      <div className={styles.preview}>
        <div className={`${styles.big} ${styles[`x-${e.tone}`]}`}>
          {kindOf(file) === "image" ? <img src={download} alt={file.name} className={styles.img} /> : <span style={{ fontSize: 30, fontWeight: 700 }}>{e.label}</span>}
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t(`kinds.${kindOf(file)}`, { provider: t(`providers.${file.linkProvider ?? "other"}`) })}</span>
        </div>
        <div className={styles.row} style={{ marginTop: 12 }}>
          {file.kind === "link" && file.linkUrl
            ? <a className="button button-primary" href={file.linkUrl} target="_blank" rel="noopener noreferrer">{t("openLink")}</a>
            : <a className="button button-primary" href={download}>{t("download")}</a>}
          {canUpload && file.kind === "upload" && <Button onClick={onNewVersion}>{t("newVersion")}</Button>}
          <Button onClick={onCopy}>{t("copyLink")}</Button>
        </div>
      </div>
      <div className={styles.info}>
        <div className={styles.infoHead}>
          <div style={{ minWidth: 0 }}>
            <h3 className={styles.h3}>{file.name}</h3>
            <div className={styles.muted} style={{ fontSize: 13 }}>{t("meta", { size: file.kind === "link" ? t("link") : formatBytes(file.size), who: file.uploader?.displayName ?? "—", date: formatDate(file.updatedAt, year) })}</div>
          </div>
          <div className={styles.row} style={{ gap: 6 }}>
            {canUpload && <Button size="small" onClick={onRename}>{t("rename")}</Button>}
            {canUpload && <Button size="small" onClick={onMove}>{t("move")}</Button>}
            {canDelete && <Button size="small" style={{ color: "#b91c1c" }} onClick={onDelete}>{t("delete")}</Button>}
          </div>
        </div>
        {detailError ? <p className={styles.err} role="alert">{message(detailError, t("failed"))}</p> : !detail ? <p className={styles.muted}>{t("loadingDetail")}</p> : (
          <div className={styles.cols}>
            <div>
              <div className={styles.label}>{t("linkedTasks")}</div>
              {detail.attachmentList.length ? detail.attachmentList.map((a) => (
                <div key={a.id} className={styles.att}>
                  {a.targetType === "issue" ? <Link href={`${pageHref}?issue=${encodeURIComponent(a.target)}`}>{label(a)}</Link> : <span>{label(a)}</span>}
                  {canUpload && <button type="button" className={styles.x} aria-label={t("detach", { target: label(a) })} onClick={() => onDetach(a)}><X size={14} /></button>}
                </div>
              )) : <div className={styles.muted} style={{ fontSize: 13 }}>{t("notLinked")}</div>}
              {canUpload && <Button size="small" style={{ marginTop: 6 }} onClick={onAttach}>{t("attachTask")}</Button>}
            </div>
            <div>
              <div className={styles.label}>{t("versions")}</div>
              {detail.versions.length ? detail.versions.map((v) => (
                <div key={v.versionNo} className={styles.ver}>
                  <Badge tone={v.current ? "blue" : "neutral"}>v{v.versionNo}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <div>{v.note || (v.versionNo === 1 ? t("firstVersion") : t("newVersionNote"))}{v.current ? ` ${t("currentVersion")}` : ""}</div>
                    <div className={`${styles.muted} ${styles.small}`}>
                      {v.uploader?.displayName ?? "—"} · {formatDate(v.createdAt, year)} · {formatBytes(v.size)}
                      {!v.current && <> · <a href={`${download}?version=${v.versionNo}`}>{t("download")}</a></>}
                    </div>
                  </div>
                </div>
              )) : <div className={styles.muted} style={{ fontSize: 13 }}>{t("linkNoVersions")}</div>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** ฟอร์มช่องเดียวที่ใช้ซ้ำ: สร้าง/เปลี่ยนชื่อโฟลเดอร์, เปลี่ยนชื่อไฟล์, ผูกกับงาน · แสดง error จาก API ในฟอร์ม */
function PromptDialog({ title, label, initial = "", placeholder, submit, onClose, onSubmit }: { title: string; label: string; initial?: string; placeholder?: string; submit: string; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const t = useTranslations("files");
  return (
    <Dialog open title={title} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setPending(true); setError("");
        try { await onSubmit(value.trim()); onClose(); } catch (x) { setError(message(x, t("failed"))); } finally { setPending(false); }
      }}>
        <Input label={label} required autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} error={error || undefined} />
        <Button type="submit" variant="primary" disabled={pending || !value.trim()}>{submit}</Button>
      </form>
    </Dialog>
  );
}

function LinkDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string, name: string) => Promise<void> }) {
  const t = useTranslations("files");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open title={t("linkTitle")} description={t("linkHint")} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        // API รับเฉพาะ https · ตรวจก่อนให้เห็นทันที
        if (!/^https:\/\//i.test(url.trim())) { setError(t("httpsOnly")); return; }
        setPending(true); setError("");
        try { await onSubmit(url.trim(), name.trim()); onClose(); } catch (x) { setError(message(x, t("failed"))); } finally { setPending(false); }
      }}>
        <Input label={t("linkUrl")} required type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} error={error || undefined} />
        <Input label={t("linkName")} value={name} onChange={(e) => setName(e.target.value)} hint={t("linkNameHint")} />
        <Button type="submit" variant="primary" disabled={pending || !url.trim()}>{t("addLinkSubmit")}</Button>
      </form>
    </Dialog>
  );
}

function MoveDialog({ file, tree, onClose, onSubmit }: { file: FileItem; tree: (Folder & { depth: number })[]; onClose: () => void; onSubmit: (folderId: string | null) => Promise<void> }) {
  const t = useTranslations("files");
  const [target, setTarget] = useState(file.folderId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open title={t("moveTitle", { name: file.name })} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <form className={styles.form} onSubmit={async (e) => {
        e.preventDefault();
        setPending(true); setError("");
        try { await onSubmit(target || null); onClose(); } catch (x) { setError(message(x, t("failed"))); } finally { setPending(false); }
      }}>
        <Select label={t("moveTo")} value={target} onChange={(e) => setTarget(e.target.value)} error={error || undefined}>
          <option value="">{t("root")}</option>
          {tree.map((f) => <option key={f.id} value={f.id}>{`${"— ".repeat(f.depth)}${f.name}`}</option>)}
        </Select>
        <Button type="submit" variant="primary" disabled={pending || target === (file.folderId ?? "")}>{t("move")}</Button>
      </form>
    </Dialog>
  );
}
