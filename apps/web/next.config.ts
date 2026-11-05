import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: { "/*": ["./messages/**/*.json"] },
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
