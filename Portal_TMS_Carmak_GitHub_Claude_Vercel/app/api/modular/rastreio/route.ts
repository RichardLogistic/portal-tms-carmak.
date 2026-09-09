import { NextRequest, NextResponse } from "next/server";
import { integrationHealth, recordIntegrationCheck } from "@/lib/integration-http";
import {
  ModularApiError,
  modularConfiguration,
  modularRequest,
  normalizeModularTracking,
} from "../_client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = modularConfiguration();

  return NextResponse.json({
    configured: configuration.configured,
    ...integrationHealth("modular"),
    carrier: "Modular Transportes",
    provider: "Modular EDI",
    authentication: configuration.authentication,
    capabilities: ["occurrences", "delivery_forecast", "delivery_proofs", "companies"],
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const nfeAccessKey = String(body?.chave_nfe ?? "").replace(/\D/g, "");
  const cteAccessKey = String(body?.chave_cte ?? "").replace(/\D/g, "");

  if (nfeAccessKey.length !== 44) {
    return NextResponse.json(
      {
        success: false,
        provider: "Modular EDI",
        message: "Informe uma chave de NF-e válida com 44 dígitos.",
      },
      { status: 400 },
    );
  }

  if (cteAccessKey && cteAccessKey.length !== 44) {
    return NextResponse.json(
      {
        success: false,
        provider: "Modular EDI",
        message: "A chave do CT-e deve conter 44 dígitos.",
      },
      { status: 400 },
    );
  }

  try {
    const payload = await modularRequest(`ocorrencias/${nfeAccessKey}`);

    const normalized = normalizeModularTracking(payload, nfeAccessKey, cteAccessKey);
    recordIntegrationCheck("modular", true);
    return NextResponse.json(normalized);
  } catch (error) {
    recordIntegrationCheck("modular", false, error instanceof ModularApiError ? error.code : "MODULAR_UNEXPECTED_ERROR");
    if (error instanceof ModularApiError) {
      return NextResponse.json(
        {
          success: false,
          provider: "Modular EDI",
          code: error.code,
          message: error.message,
          ...(error.upstreamStatus
            ? { upstreamStatus: error.upstreamStatus }
            : {}),
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        success: false,
        provider: "Modular EDI",
        code: "MODULAR_UNEXPECTED_ERROR",
        message: "A integração EDI da Modular está temporariamente indisponível.",
      },
      { status: 502 },
    );
  }
}
