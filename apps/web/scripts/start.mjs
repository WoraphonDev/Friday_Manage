// standalone ไม่คัดลอก static/public ให้อัตโนมัติ จึงเตรียมก่อนเปิด production server
import { cp, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const standalone = new URL(".next/standalone/apps/web/", root);
await cp(new URL(".next/static/", root), new URL(".next/static/", standalone), { recursive: true });
const publicDir = new URL("public/", root);
if (await access(publicDir).then(() => true, () => false)) {
  await cp(publicDir, new URL("public/", standalone), { recursive: true });
}
process.env.HOSTNAME ??= "127.0.0.1";
await import(new URL("server.js", standalone).href);
