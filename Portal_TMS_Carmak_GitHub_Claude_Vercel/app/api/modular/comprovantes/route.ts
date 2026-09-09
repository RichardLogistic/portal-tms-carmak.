import { NextRequest, NextResponse } from "next/server";
import {
  ModularApiError,
  modularRequest,
  normalizeModularProofs,
} from "../_client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PROOF_BYTES = 15 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

export async function GET(request: NextRequest) {
  const nfeAccessKey = String(
    request.nextUrl.searchParams.get("chave_nfe") ?? "",
  ).replace(/\D/g, "");
  const fileParameter = request.nextUrl.searchParams.get("arquivo");

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

  try {
    const payload = await modularRequest(`comprovantes/${nfeAccessKey}`);
    const proofs = normalizeModularProofs(payload);

    if (fileParameter === null) {
      return NextResponse.json({
        success: true,
        provider: "Modular EDI",
        total: proofs.length,
        comprovantes: proofs.map(({ content: _content, ...proof }) => ({
          ...proof,
          downloadUrl:
            `/api/modular/comprovantes?chave_nfe=${nfeAccessKey}` +
            `&arquivo=${proof.index}`,
        })),
      });
    }

    if (!/^\d+$/.test(fileParameter)) {
      return NextResponse.json(
        { success: false, message: "Comprovante solicitado inválido." },
        { status: 400 },
      );
    }

    const proof = proofs[Number(fileParameter)];

    if (!proof || !proof.content) {
      return NextResponse.json(
        { success: false, message: "Comprovante de entrega não encontrado." },
        { status: 404 },
      );
    }

    const base64 = proof.content.replace(/^data:[^;]+;base64,/, "");
    if (base64.length * 0.75 > MAX_PROOF_BYTES) {
      return NextResponse.json(
        { success: false, message: "O comprovante excede o tamanho permitido." },
        { status: 413 },
      );
    }

    const filename = proof.originalName
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "_") || `comprovante.${proof.extension}`;
    const content = new Uint8Array(Buffer.from(base64, "base64"));

    return new NextResponse(content, {
      headers: {
        "Content-Type":
          MIME_TYPES[proof.extension] || "application/octet-stream",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
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
        message: "Não foi possível consultar os comprovantes da Modular.",
      },
      { status: 502 },
    );
  }
}
