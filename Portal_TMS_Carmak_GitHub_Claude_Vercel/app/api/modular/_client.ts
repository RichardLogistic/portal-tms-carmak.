const DEFAULT_MODULAR_API_BASE_URL =
  "https://sistemamodular.com.br/api/edi/v1";
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000;

type JsonObject = Record<string, unknown>;

export type ModularConfiguration = {
  baseUrl: string;
  username: string;
  password: string;
  staticToken: string;
  configured: boolean;
  authentication: "token" | "username_password" | "not_configured";
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export type ModularTrackingEvent = {
  codigo: string;
  ocorrencia: string;
  tipo: string;
  descricao: string;
  data_hora: string;
  data_hora_efetiva: string;
  cidade: string;
  filial: string;
};

let cachedToken: CachedToken | null = null;
let tokenRequest: Promise<string> | null = null;

export class ModularApiError extends Error {
  status: number;
  code: string;
  upstreamStatus?: number;

  constructor(
    message: string,
    status: number,
    code: string,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ModularApiError";
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function digits(value: unknown): string {
  return asText(value).replace(/\D/g, "");
}

function upstreamMessage(payload: unknown): string {
  const value = asObject(payload);
  return (
    asText(value?.message) ||
    asText(value?.mensagem) ||
    asText(value?.erro) ||
    asText(value?.error)
  ).slice(0, 240);
}

export function modularConfiguration(): ModularConfiguration {
  const baseUrl = (
    process.env.MODULAR_API_BASE_URL?.trim() || DEFAULT_MODULAR_API_BASE_URL
  ).replace(/\/+$/, "");
  const username = process.env.MODULAR_API_USER?.trim() || "";
  const password = process.env.MODULAR_API_PASSWORD?.trim() || "";
  const staticToken = process.env.MODULAR_API_TOKEN?.trim() || "";
  const configured = Boolean(staticToken || (username && password));

  return {
    baseUrl,
    username,
    password,
    staticToken,
    configured,
    authentication: staticToken
      ? "token"
      : username && password
        ? "username_password"
        : "not_configured",
  };
}

export function resetModularTokenCache() {
  cachedToken = null;
  tokenRequest = null;
}

function tokenExpiresAt(token: string): number {
  const payload = token.split(".")[1];

  if (payload) {
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { exp?: unknown };

      if (typeof decoded.exp === "number" && decoded.exp > 0) {
        return decoded.exp * 1000;
      }
    } catch {
      // Tokens opacos continuam válidos pelo tempo conservador definido abaixo.
    }
  }

  return Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");

  if (!text.trim()) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModularApiError(
      "A Modular retornou uma resposta inválida para a integração EDI.",
      502,
      "MODULAR_INVALID_RESPONSE",
      response.status,
    );
  }
}

function configurationError() {
  return new ModularApiError(
    "Cadastre MODULAR_API_USER e MODULAR_API_PASSWORD nas configurações seguras do portal para ativar a integração da Modular.",
    503,
    "MODULAR_CONFIGURATION_REQUIRED",
  );
}

async function requestNewToken(
  configuration: ModularConfiguration,
): Promise<string> {
  if (!configuration.username || !configuration.password) {
    throw configurationError();
  }

  let response: Response;

  try {
    response = await fetch(`${configuration.baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Portal-TMS-Carmak/1.0",
      },
      body: JSON.stringify({
        Usuario: configuration.username,
        Senha: configuration.password,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";

    throw new ModularApiError(
      timedOut
        ? "A autenticação na Modular excedeu 20 segundos."
        : "Não foi possível acessar a autenticação da Modular.",
      502,
      timedOut ? "MODULAR_AUTH_TIMEOUT" : "MODULAR_AUTH_UNAVAILABLE",
    );
  }

  const payload = await readJson(response);

  if (!response.ok) {
    const authenticationFailed = response.status === 401 || response.status === 403;

    throw new ModularApiError(
      authenticationFailed
        ? "Usuário ou senha da Modular inválidos. Confira as credenciais cadastradas nas configurações seguras do portal."
        : upstreamMessage(payload) || "A Modular não autorizou a integração EDI.",
      502,
      authenticationFailed ? "MODULAR_AUTH_FAILED" : "MODULAR_AUTH_UPSTREAM_ERROR",
      response.status,
    );
  }

  const token = asText(asObject(payload)?.access_token);

  if (!token) {
    throw new ModularApiError(
      "A Modular não retornou o token de autenticação esperado.",
      502,
      "MODULAR_TOKEN_MISSING",
      response.status,
    );
  }

  cachedToken = { value: token, expiresAt: tokenExpiresAt(token) };
  return token;
}

async function getToken(forceRefresh = false): Promise<string> {
  const configuration = modularConfiguration();

  if (!configuration.configured) throw configurationError();
  if (configuration.staticToken) return configuration.staticToken;

  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
  ) {
    return cachedToken.value;
  }

  if (!tokenRequest) {
    tokenRequest = requestNewToken(configuration).finally(() => {
      tokenRequest = null;
    });
  }

  return tokenRequest;
}

function upstreamError(response: Response, payload: unknown): ModularApiError {
  if (response.status === 401 || response.status === 403) {
    return new ModularApiError(
      response.status === 403
        ? "A Modular não autorizou a consulta para a empresa ou NF-e informada."
        : "A autenticação da Modular expirou ou foi recusada.",
      502,
      response.status === 403 ? "MODULAR_ACCESS_DENIED" : "MODULAR_AUTH_FAILED",
      response.status,
    );
  }

  if (response.status === 404) {
    return new ModularApiError(
      upstreamMessage(payload) ||
        "A Modular não encontrou dados para a NF-e informada.",
      404,
      "MODULAR_NOT_FOUND",
      response.status,
    );
  }

  return new ModularApiError(
    upstreamMessage(payload) || "A integração EDI da Modular está indisponível.",
    502,
    "MODULAR_UPSTREAM_ERROR",
    response.status,
  );
}

export async function modularRequest(path: string): Promise<unknown> {
  const configuration = modularConfiguration();
  let token = await getToken();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(
        `${configuration.baseUrl}/${path.replace(/^\/+/, "")}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "Portal-TMS-Carmak/1.0",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";

      throw new ModularApiError(
        timedOut
          ? "A consulta à Modular excedeu 20 segundos."
          : "Não foi possível acessar a integração EDI da Modular.",
        502,
        timedOut ? "MODULAR_REQUEST_TIMEOUT" : "MODULAR_UNAVAILABLE",
      );
    }

    if (
      response.status === 401 &&
      attempt === 0 &&
      !configuration.staticToken
    ) {
      cachedToken = null;
      token = await getToken(true);
      continue;
    }

    if (response.status === 204) return [];

    const payload = await readJson(response);
    if (!response.ok) throw upstreamError(response, payload);
    return payload;
  }

  throw new ModularApiError(
    "A autenticação da Modular não pôde ser renovada.",
    502,
    "MODULAR_AUTH_FAILED",
  );
}

function selectModularDocument(
  payload: unknown,
  nfeAccessKey: string,
  cteAccessKey?: string,
): JsonObject {
  const root = asObject(payload);
  const wrapped = root?.data ?? root?.dados ?? root?.documentos;
  const documents = (Array.isArray(payload)
    ? payload
    : Array.isArray(wrapped)
      ? wrapped
      : root
        ? [root]
        : []
  ).map(asObject).filter((document): document is JsonObject => Boolean(document));

  if (!documents.length) {
    throw new ModularApiError(
      "A Modular não retornou CT-e ou ocorrências para esta NF-e.",
      404,
      "MODULAR_NOT_FOUND",
    );
  }

  const nfeMatches = documents.filter((document) => {
    const returnedNfe = digits(document.Chave_NFe);
    return !returnedNfe || returnedNfe === nfeAccessKey;
  });

  if (!nfeMatches.length) {
    throw new ModularApiError(
      "A Modular retornou uma NF-e diferente da solicitada.",
      404,
      "MODULAR_NFE_MISMATCH",
    );
  }

  if (!cteAccessKey) return nfeMatches[0];

  const matchingCte = nfeMatches.find(
    (document) => digits(document.Chave_CTe) === cteAccessKey,
  );
  if (matchingCte) return matchingCte;

  const documentWithoutCteKey = nfeMatches.find(
    (document) => !digits(document.Chave_CTe),
  );
  if (documentWithoutCteKey) return documentWithoutCteKey;

  throw new ModularApiError(
    "A NF-e retornou um CT-e diferente na Modular; o rastreamento não foi vinculado.",
    404,
    "MODULAR_CTE_MISMATCH",
  );
}

function normalizeEvent(value: unknown): ModularTrackingEvent | null {
  const event = asObject(value);
  if (!event) return null;

  const description =
    asText(event.Descricao) || asText(event.Ocorrencia) || "Atualização Modular";
  const date = asText(event.Data);

  return {
    codigo: asText(event.Ocorrencia),
    ocorrencia: description,
    tipo: description,
    descricao: description,
    data_hora: date,
    data_hora_efetiva: date,
    cidade: asText(event.Cidade),
    filial: asText(event.Filial),
  };
}

export function normalizeModularTracking(
  payload: unknown,
  nfeAccessKey: string,
  cteAccessKey?: string,
) {
  const document = selectModularDocument(payload, nfeAccessKey, cteAccessKey);
  const rawEvents = Array.isArray(document.Ocorrencias)
    ? document.Ocorrencias
    : [];
  const tracking = rawEvents
    .map(normalizeEvent)
    .filter((event): event is ModularTrackingEvent => Boolean(event));
  const deliveryDate = asText(document.Data_Entrega);

  if (
    deliveryDate &&
    !tracking.some((event) =>
      /entregue|entrega realizada|comprovante de entrega/i.test(
        event.ocorrencia,
      ),
    )
  ) {
    tracking.push({
      codigo: "ENTREGA",
      ocorrencia: "Entrega realizada",
      tipo: "Entrega realizada",
      descricao: "Entrega confirmada pela API EDI da Modular.",
      data_hora: deliveryDate,
      data_hora_efetiva: deliveryDate,
      cidade: asText(asObject(document.Destinatario)?.Cidade),
      filial: "",
    });
  }

  return {
    success: true,
    source: "MODULAR_EDI_API",
    provider: "Modular EDI",
    carrier: "Modular Transportes",
    documento: {
      header: {
        chave_nfe: asText(document.Chave_NFe) || nfeAccessKey,
        chave_cte: asText(document.Chave_CTe),
        tipo_documento: asText(document.Tipo_Documento),
        numero_documento: asText(document.Documento),
        emissao: asText(document.Emissao),
        cif_fob: asText(document.Cif_Fob),
        previsao_entrega: asText(document.Previsao_Entrega),
        data_entrega: deliveryDate,
        data_baixa: asText(document.Data_Baixa),
        remetente: asObject(document.Remetente) || {},
        destinatario: asObject(document.Destinatario) || {},
        responsavel: asObject(document.Responsavel) || {},
      },
      tracking,
    },
  };
}

export function normalizeModularCompanies(payload: unknown) {
  const root = asObject(payload);
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.empresas)
      ? root.empresas
      : Array.isArray(root?.Empresas)
        ? root.Empresas
        : Array.isArray(root?.Ocorrencias)
          ? root.Ocorrencias
          : [];

  return values
    .map(asObject)
    .filter((company): company is JsonObject => Boolean(company))
    .map((company) => ({
      cnpj: digits(company.Cnpj),
      name: asText(company.Nome),
      baseCnpj: asText(company.Base_Cnpj),
      responsibleCondition: asText(company.Condicao_Responsavel),
    }));
}

export function normalizeModularProofs(payload: unknown) {
  const root = asObject(payload);
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.comprovantes)
      ? root.comprovantes
      : Array.isArray(root?.Comprovantes)
        ? root.Comprovantes
        : root
          ? [root]
          : [];

  return values
    .map(asObject)
    .filter((proof): proof is JsonObject => Boolean(proof))
    .map((proof, index) => ({
      index,
      documentType: asText(proof.Tipo_Documento),
      documentNumber: asText(proof.Documento),
      emissionDate: asText(proof.Emissao),
      cteAccessKey: asText(proof.Chave_CTe),
      deliveryDate: asText(proof.Data_Entrega),
      registeredAt: asText(proof.Cadastro),
      originalName:
        asText(proof.Nome_Original) || asText(proof.Nome) || `comprovante-${index + 1}`,
      extension: asText(proof.arquivo_extensao).toLowerCase(),
      sizeKb: asText(proof.Tamanho_KB),
      content: asText(proof.arquivo_conteudo),
    }));
}
