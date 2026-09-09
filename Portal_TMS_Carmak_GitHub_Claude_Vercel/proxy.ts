import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./app/api/auth/_session";

// Protege o portal (Qive, SSW, TW e a própria tela operacional) atrás de uma
// sessão válida. /api/auth/* e /login ficam de fora — é por onde o login
// acontece. O bypass é feito dentro da função (não no matcher) porque o
// matcher do Next.js usa path-to-regexp, que não suporta negative lookahead
// de forma confiável.
export const config = {
  matcher: ["/", "/portal.html", "/api/:path*"],
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/auth/") || pathname === "/login") {
    return NextResponse.next();
  }

  const isPage = pathname === "/" || pathname === "/portal.html";
  const sessionSecret = process.env.SESSION_SECRET;

  if (!sessionSecret) {
    if (isPage) return NextResponse.next();
    return NextResponse.json(
      { success: false, code: "AUTH_NOT_CONFIGURED", message: "Login ainda não configurado no servidor." },
      { status: 503 },
    );
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token, sessionSecret);

  if (!session) {
    if (isPage) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json(
      { success: false, code: "UNAUTHORIZED", message: "Faça login para acessar esta integração." },
      { status: 401 },
    );
  }

  return NextResponse.next();
}
