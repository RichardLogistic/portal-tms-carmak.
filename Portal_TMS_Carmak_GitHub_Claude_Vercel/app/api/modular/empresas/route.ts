import { NextResponse } from "next/server";
import {
  ModularApiError,
  modularRequest,
  normalizeModularCompanies,
} from "../_client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const payload = await modularRequest("empresas");
    const companies = normalizeModularCompanies(payload);

    return NextResponse.json({
      success: true,
      provider: "Modular EDI",
      total: companies.length,
      companies,
    });
  } catch (error) {
    if (error instanceof ModularApiError) {
      return NextResponse.json(
        {
          success: false,
          provider: "Modular EDI",
          code: error.code,
          message: error.message,
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        success: false,
        provider: "Modular EDI",
        message: "Não foi possível consultar as empresas autorizadas na Modular.",
      },
      { status: 502 },
    );
  }
}
