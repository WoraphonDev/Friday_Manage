import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // ตรวจแค่ว่ามี cookie เพื่อพาไป Login ก่อน render · session จริงตรวจซ้ำที่ ops/auth/me
  if (!request.cookies.get("fm_ops")?.value) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/", "/workspaces/:path*", "/users/:path*", "/payments/:path*", "/refunds/:path*", "/support/:path*", "/system/:path*", "/incidents/:path*", "/privacy/:path*", "/legal/:path*", "/business/:path*", "/staff/:path*", "/soon/:path*", "/flags/:path*", "/entitlements/:path*", "/deliveries/:path*", "/m/:path*"] };
