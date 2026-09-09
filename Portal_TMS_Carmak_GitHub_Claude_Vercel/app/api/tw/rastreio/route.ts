import { NextRequest, NextResponse } from "next/server";
import { fetchWithRetry, integrationHealth, recordIntegrationCheck } from "@/lib/integration-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_TRACKING_URL = "https://ssw.inf.br/api/trackingdanfe";
const REQUEST_TIMEOUT_MS = 15_000;

type TrackingPayload = {
  success?: boolean;
  message?: string;
  documento?: {
    header?: Record<string, unknown>;
    tracking?: unknown[];
  };
  [key: string]: unknown;
};

function trackingUrl() {
  return process.env.TW_RASTREIO_URL?.trim() || DEFAULT_TRACKING_URL;
}

function providerName(url: string) {
  try {
    return new URL(url).hostname.endsWith("ssw.inf.br") ? "TW via SSW" : "TW Transportes";
  } catch {
    return "TW Transportes";
  }
}

function safeUpstreamMessage(payload: TrackingPayload | null) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  return message.slice(0, 240) || "A TW não localizou rastreamento para esta NF-e.";
}

export async function GET() {
  const url = trackingUrl();
  return NextResponse.json({
    configured: true,
    carrier: "TW Transportes",
    provider: providerName(url),
    authentication: process.env.TW_API_TOKEN ? "token" : "public",
    ...integrationHealth("tw"),
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

  const url = trackingUrl();
  const token = process.env.TW_API_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Portal-TMS-Carmak/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ chave_nfe: accessKey }),
        cache: "no-store",
      },
      { timeoutMs: REQUEST_TIMEOUT_MS, budgetMs: REQUEST_TIMEOUT_MS * 2 },
    );
    const payload = (await response.json().catch(() => null)) as TrackingPayload | null;

    if (!response.ok) {
      recordIntegrationCheck("tw", false, "TW_UPSTREAM_ERROR");
      return NextResponse.json(
        {
          success: false,
          message: safeUpstreamMessage(payload),
          provider: providerName(url),
          upstreamStatus: response.status,
        },
        { status: 502 },
      );
    }

    if (!payload || payload.success === false) {
      recordIntegrationCheck("tw", false, "TW_NOT_FOUND");
      return NextResponse.json(
        {
          success: false,
          message: safeUpstreamMessage(payload),
          provider: providerName(url),
        },
        { status: 404 },
      );
    }

    const documento = payload.documento && typeof payload.documento === "object"
      ? payload.documento
      : { header: {}, tracking: [] };

    recordIntegrationCheck("tw", true);
    return NextResponse.json({
      ...payload,
      success: true,
      source: providerName(url) === "TW via SSW" ? "TW_SSW_API" : "TW_API",
      provider: providerName(url),
      documento: {
        ...documento,
        header: documento.header && typeof documento.header === "object" ? documento.header : {},
        tracking: Array.isArray(documento.tracking) ? documento.tracking : [],
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    recordIntegrationCheck("tw", false, timedOut ? "TW_TIMEOUT" : "TW_UNAVAILABLE");
    return NextResponse.json(
      {
        success: false,
        message: timedOut
          ? "A consulta à TW excedeu 15 segundos. O portal tentará novamente na próxima atualização."
          : "A integração da TW está temporariamente indisponível.",
        provider: providerName(url),
      },
      { status: 502 },
    );
  }
}
