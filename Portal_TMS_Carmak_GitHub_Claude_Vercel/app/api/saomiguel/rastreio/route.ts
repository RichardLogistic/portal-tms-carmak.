import { NextRequest, NextResponse } from "next/server";
import { integrationHealth, recordIntegrationCheck } from "@/lib/integration-http";
import {
  SaoMiguelApiError,
  decodeAccessKey,
  normalizeSaoMiguelTracking,
  saoMiguelConfiguration,
  trackingRequest,
} from "../_client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const configuration = saoMiguelConfiguration();

  return NextResponse.json({
    configured: configuration.configured,
    ...integrationHealth("saomiguel"),
    carrier: "Expresso São Miguel",
    provider: "SAOMIGUEL_API",
    capabilities: [
      "tracking_by_nfe",
      "tracking_by_cte",
      "linked_nfes",
      "delivery_forecast",
      "freight_value",
      "delivery_proofs",
      "geolocation",
    ],
    // O manual não publica o limite por minuto; não inventamos um número aqui.
    limits: null,
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const nfeAccessKey = digitsOnly(body?.chave_nfe);
  const cteAccessKey = digitsOnly(body?.chave_cte);

  // Prioriza o conhecimento (CT-e) quando disponível: é o modelo de
  // consulta validado diretamente contra a API real.
  const primaryKey = cteAccessKey || nfeAccessKey;
  const decoded = decodeAccessKey(primaryKey);

  if (!decoded || !["55", "57"].includes(decoded.model) || (cteAccessKey && decoded.model !== "57")) {
    return NextResponse.json(
      {
        success: false,
        provider: "Expresso São Miguel",
        message: "Informe uma chave de CT-e ou NF-e válida com 44 dígitos.",
      },
      { status: 400 },
    );
  }

  const modeloConsulta =
    decoded.model === "57"
      ? "TRACKING_COMPLETO_POR_CONHECIMENTO_E_COMPROVANTE"
      : "TRACKING_COMPLETO_POR_NOTA_FISCAL_E_COMPROVANTE";

  const configuration = saoMiguelConfiguration();

  try {
    // configuration.customer (CNPJ da matriz) é usado como cpfOuCnpj/Cnpj em
    // toda consulta, mesmo quando o documento pertence a outra filial: a São
    // Miguel confirmou por escrito que habilita as consultas para a raiz do
    // CNPJ, então qualquer filial sob essa raiz é retornada com essa mesma
    // credencial.
    const payload = await trackingRequest(modeloConsulta, [
      configuration.customer,
      decoded.number,
      decoded.series || null,
    ]);

    const normalized = normalizeSaoMiguelTracking(payload, primaryKey, decoded);
    recordIntegrationCheck("saomiguel", true);
    return NextResponse.json(normalized);
  } catch (error) {
    recordIntegrationCheck("saomiguel", false, error instanceof SaoMiguelApiError ? error.code : "SAOMIGUEL_UNEXPECTED_ERROR");
    if (error instanceof SaoMiguelApiError) {
      return NextResponse.json(
        {
          success: false,
          provider: "Expresso São Miguel",
          code: error.code,
          message: error.message,
          ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
        },
        { status: error.status, headers: error.status === 429 ? { "Retry-After": "60" } : {} },
      );
    }

    return NextResponse.json(
      {
        success: false,
        provider: "Expresso São Miguel",
        code: "SAOMIGUEL_UNEXPECTED_ERROR",
        message: "A integração da Expresso São Miguel está temporariamente indisponível.",
      },
      { status: 502 },
    );
  }
}

function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}
