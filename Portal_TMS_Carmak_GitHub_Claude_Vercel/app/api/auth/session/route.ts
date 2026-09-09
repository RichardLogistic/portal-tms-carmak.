import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../_session";

// Permite ao cliente confirmar se o cookie de sessão ainda é válido antes de
// mostrar a aplicação com base num marcador antigo salvo em localStorage
// (que pode ser de uma sessão já expirada ou de antes do login real existir).
export async function GET(request: NextRequest) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    return NextResponse.json({ authenticated: false }, { status: 503 });
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token, sessionSecret);

  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true, email: session.email });
}
