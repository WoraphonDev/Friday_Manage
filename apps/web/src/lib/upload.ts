import { api, ApiError } from "./api";

/** ปลายทางอัปโหลดที่ API ออกให้ (POST p/files/upload-url) */
export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  uploadToken: string;
  expiresAt: string;
  maxBytes: number;
  storage: string;
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

export interface UploadedFile { id: string; name: string }

/**
 * อัปโหลดไฟล์เข้า Files ของโปรเจกต์ แล้วแนบกับงาน / คอมเมนต์ / ผลทดสอบตามที่ระบุ
 * ใช้ในหน้า Task (ไฟล์แนบ, คอมเมนต์, ผลทดสอบ) โดยไม่ต้องไปหน้า Files ก่อน
 */
export async function uploadToProject(ws: string, projectKey: string, file: File, attach?: { targetType: "issue" | "comment" | "test_run"; target: string }): Promise<UploadedFile> {
  const base = `/w/${encodeURIComponent(ws)}/projects/${encodeURIComponent(projectKey)}`;
  const target = await api.post<UploadTarget>(`${base}/files/upload-url`, { name: file.name, size: file.size, mime: file.type || undefined });
  await putFile({ ...target, url: uploadUrl(target) }, file, () => undefined, () => undefined);
  const created = await api.post<UploadedFile>(`${base}/files`, { uploadToken: target.uploadToken });
  if (attach) await api.post(`${base}/files/${created.id}/attachments`, attach);
  return { id: created.id, name: created.name ?? file.name };
}
