import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE_NAME, createSessionToken } from "../_session";

export const runtime = "nodejs";

const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const SESSION_TTL_DEFAULT_MS = 12 * 60 * 60 * 1000; // 12 horas

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export async function POST(request: NextRequest) {
  const configuredEmail = process.env.PORTAL_AUTH_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.PORTAL_AUTH_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!configuredEmail || !configuredPassword || !sessionSecret) {
    return NextResponse.json(
      {
        success: false,
        code: "AUTH_NOT_CONFIGURED",
        message: "Login ainda não configurado no servidor.",
      },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const remember = Boolean(body?.remember);

  const emailOk = email.length > 0 && safeEqual(email, configuredEmail);
  const passwordOk = password.length > 0 && safeEqual(password, configuredPassword);

  if (!emailOk || !passwordOk) {
    return NextResponse.json(
      {
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "E-mail ou senha inválidos.",
      },
      { status: 401 },
    );
  }

  const ttlMs = remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_DEFAULT_MS;
  const token = await createSessionToken({ email: configuredEmail, exp: Date.now() + ttlMs }, sessionSecret);

  const response = NextResponse.json({ success: true, email: configuredEmail });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
  return response;
}
