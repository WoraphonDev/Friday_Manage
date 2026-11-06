import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // ตรวจแค่ว่ามี cookie เพื่อพาไป Login ก่อน render · session จริงตรวจซ้ำที่ ops/auth/me
  if (!request.cookies.get("fm_ops")?.value) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/", "/workspaces/:path*", "/payments/:path*", "/support/:path*", "/flags/:path*"] };
