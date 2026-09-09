import { NextRequest, NextResponse } from "next/server";
import { SaoMiguelApiError, comprovanteRequest, normalizeSaoMiguelComprovante } from "../_client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim();

  if (!id) {
    return NextResponse.json(
      { success: false, provider: "Expresso São Miguel", message: "Informe o parâmetro id (idComprovante)." },
      { status: 400 },
    );
  }

  try {
    const payload = await comprovanteRequest(id);
    return NextResponse.json(normalizeSaoMiguelComprovante(payload));
  } catch (error) {
    if (error instanceof SaoMiguelApiError) {
      return NextResponse.json(
        {
          success: false,
          provider: "Expresso São Miguel",
          code: error.code,
          message: error.message,
          ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        success: false,
        provider: "Expresso São Miguel",
        code: "SAOMIGUEL_UNEXPECTED_ERROR",
        message: "Não foi possível consultar o comprovante da Expresso São Miguel.",
      },
      { status: 502 },
    );
  }
}
