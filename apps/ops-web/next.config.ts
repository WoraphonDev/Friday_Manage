import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
  // proxy ไป ops-api ใน origin เดียว: cookie `fm_ops` (SameSite=Strict) และ Origin ของคำขอเขียนตรงกับ OPS_WEB_ORIGIN โดยไม่ต้องเปิด CORS
  async rewrites() {
    return [
      {
        source: "/ops-api/:path*",
        destination: `${process.env.OPS_API_ORIGIN ?? "http://127.0.0.1:3002"}/ops/:path*`,
      },
    ];
  },
  async headers() {
    // หลังบ้านห้ามถูกฝังใน iframe (กัน clickjacking ปุ่มระงับ / ยืนยันเงิน)
    return [{ source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);
