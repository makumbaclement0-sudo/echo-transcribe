import { NextRequest, NextResponse } from "next/server";

// Protect the whole site with HTTP Basic Auth. Credentials come from env vars
// (APP_USER / APP_PASSWORD). If they aren't set, the site stays open so you
// can't accidentally lock yourself out.
export const config = {
  // Apply to everything except Next.js static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;

  // Not configured → don't lock the site.
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (timingSafeEqual(u, user) && timingSafeEqual(p, pass)) {
        return NextResponse.next();
      }
    } catch {
      // fall through to 401
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Echo", charset="UTF-8"' },
  });
}
