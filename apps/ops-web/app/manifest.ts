import type { MetadataRoute } from "next";

/** เพิ่มลงหน้าจอโฮมได้ (iPhone รับ Web Push เฉพาะเว็บที่เพิ่มลงหน้าจอโฮม) · เปิดที่หน้ามือถือ */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Friday Ops",
    short_name: "Friday Ops",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    lang: "th",
    background_color: "#f5f6f7",
    theme_color: "#1c1f23",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
