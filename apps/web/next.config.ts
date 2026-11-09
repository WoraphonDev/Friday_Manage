import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/*": ["./messages/**/*.json"] },
  // ที่อยู่หน้าเว็บย้ายจาก /w/... เป็น /work/... (ผู้ใช้ตัดสิน 2026-11-09) · ลิงก์เก่าในอีเมล / bookmark ยังเปิดได้
  // ใช้ 307 ไม่ใช่ 308 เพื่อไม่ให้เบราว์เซอร์จำถาวรถ้าเปลี่ยนอีก · API ยังเป็น /api/v1/w/... ไม่โดนกฎนี้
  async redirects() {
    return [{ source: "/w/:path*", destination: "/work/:path*", permanent: false }];
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.API_ORIGIN ?? "http://127.0.0.1:3001"}/api/v1/:path*`,
      },
    ];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
