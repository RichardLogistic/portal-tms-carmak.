import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_TRACKING_URL = "https://ssw.inf.br/api/trackingdanfe";
const DEFAULT_CARRIERS = ["Adonai", "União", "Estrela Vermelha"];
const REQUEST_TIMEOUT_MS = 15_000;

type TrackingPayload = {
  success?: boolean;
  message?: string;
  documento?: {
    header?: Record<string, unknown>;
    tracking?: unknown[];
  };
};

function trackingUrl() {
  return process.env.SSW_RASTREIO_URL?.trim() || DEFAULT_TRACKING_URL;
}

function configuredCarriers() {
  const carriers = process.env.TMS_SSW_CARRIERS?.split(/[;,\n]+/)
    .map((carrier) => carrier.trim())
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_CARRIERS, ...(carriers ?? [])]));
}

function safeMessage(payload: TrackingPayload | null) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  return message.slice(0, 240) || "A SSW não localizou rastreamento para esta NF-e.";
}

export async function GET() {
  return NextResponse.json({
    configured: true,
    provider: "SSW",
    carriers: configuredCarriers(),
    discovery: {
      enabled: true,
      strategy: "linked_nfe_access_key",
      confirmation: "returned_tracking_events",
    },
    authentication: process.env.SSW_API_TOKEN ? "token" : "public",
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const accessKey = String(body?.chave_nfe ?? "").replace(/\D/g, "");

  if (accessKey.length !== 44) {
    return NextResponse.json(
      { success: false, message: "Informe uma chave de NF-e válida com 44 dígitos." },
      { status: 400 },
    );
  }

  const token = process.env.SSW_API_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Portal-TMS-Carmak/1.0",
  };

  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(trackingUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ chave_nfe: accessKey }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as TrackingPayload | null;

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          message: safeMessage(payload),
          provider: "SSW",
          upstreamStatus: response.status,
        },
        { status: 502 },
      );
    }

    if (!payload || payload.success === false) {
      return NextResponse.json(
        { success: false, message: safeMessage(payload), provider: "SSW" },
        { status: 404 },
      );
    }

    const document =
      payload.documento && typeof payload.documento === "object"
        ? payload.documento
        : { header: {}, tracking: [] };

    return NextResponse.json({
      success: true,
      source: "SSW_API",
      provider: "SSW",
      documento: {
        header:
          document.header && typeof document.header === "object" ? document.header : {},
        tracking: Array.isArray(document.tracking) ? document.tracking : [],
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";

    return NextResponse.json(
      {
        success: false,
        message: timedOut
          ? "A consulta à SSW excedeu 15 segundos. O portal tentará novamente na próxima atualização."
          : "A integração SSW está temporariamente indisponível.",
        provider: "SSW",
      },
      { status: 502 },
    );
  }
}
