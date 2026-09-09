/**
 * Cliente da API de rastreamento da Expresso São Miguel.
 *
 * Fonte: "API Integração Cliente - Ocorrências de Entrega / Expresso São
 * Miguel / 2026" (manual técnico) + validação direta contra a API real
 * (POST /tracking com um CT-e real da base devolveu o tracking completo,
 * incluindo `idComprovante`; GET /comprovante com esse id devolveu fotos
 * reais + latitude/longitude).
 *
 * Igual às demais integrações (Qive, SSW, TW): tudo roda no servidor.
 * Nenhuma credencial chega ao portal.html.
 */

import { fetchWithRetry, retryAfterMs } from "@/lib/integration-http";

const DEFAULT_BASE_URL =
  "https://wsintegcli02.expressosaomiguel.com.br:40504/wsservernet/api";
const REQUEST_TIMEOUT_MS = 20_000;
let nextRequestAt = 0;
let cooldownUntil = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  if (cooldownUntil > now) throw new SaoMiguelApiError("Aguarde a liberação do limite da Expresso São Miguel.", 429, "SAOMIGUEL_RATE_LIMITED", 429);
  const configured = Number(process.env.SAOMIGUEL_REQUEST_INTERVAL_MS);
  const interval = Number.isFinite(configured) && configured >= 1000 ? Math.min(configured, 60_000) : 2000;
  const slot = Math.max(now, nextRequestAt);
  if (slot - now > 10_000) throw new SaoMiguelApiError("Consultas da Expresso São Miguel em andamento. Tente novamente em alguns segundos.", 429, "SAOMIGUEL_QUEUE_BUSY");
  nextRequestAt = slot + interval;
  if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
  if (cooldownUntil > Date.now()) throw new SaoMiguelApiError("Aguarde a liberação do limite da Expresso São Miguel.", 429, "SAOMIGUEL_RATE_LIMITED", 429);
}

type JsonObject = Record<string, unknown>;

export type SaoMiguelConfiguration = {
  baseUrl: string;
  customer: string;
  accessKey: string;
  configured: boolean;
};

export class SaoMiguelApiError extends Error {
  status: number;
  code: string;
  upstreamStatus?: number;

  constructor(message: string, status: number, code: string, upstreamStatus?: number) {
    super(message);
    this.name = "SaoMiguelApiError";
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value != null ? String(value) : "";
}

function digits(value: unknown): string {
  return asText(value).replace(/\D/g, "");
}

export function saoMiguelConfiguration(): SaoMiguelConfiguration {
  const baseUrl = (process.env.SAOMIGUEL_API_BASE?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const customer = digits(process.env.SAOMIGUEL_CUSTOMER);
  const accessKey = process.env.SAOMIGUEL_ACCESS_KEY?.trim() || "";

  return { baseUrl, customer, accessKey, configured: Boolean(customer && accessKey) };
}

function configurationError() {
  return new SaoMiguelApiError(
    "Cadastre SAOMIGUEL_CUSTOMER e SAOMIGUEL_ACCESS_KEY nas configurações seguras do portal para ativar a integração da Expresso São Miguel.",
    503,
    "SAOMIGUEL_CONFIGURATION_REQUIRED",
  );
}

/**
 * Chave de acesso de 44 dígitos (NFe ou CTe) -> UF/AAMM/CNPJ emitente/
 * modelo/série/número, conforme o layout nacional (mesma decodificação já
 * usada pelo cliente SSW deste portal). A São Miguel não aceita consulta
 * por chave — precisa de número + série (ver manual, seções 2.2/2.3).
 */
export function decodeAccessKey(accessKey: string) {
  const key = digits(accessKey);
  if (key.length !== 44) return null;

  return {
    uf: key.slice(0, 2),
    yearMonth: key.slice(2, 6),
    emitterCnpj: key.slice(6, 20),
    model: key.slice(20, 22),
    series: Number(key.slice(22, 25)),
    number: Number(key.slice(25, 34)),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SaoMiguelApiError(
      "A Expresso São Miguel retornou uma resposta inválida.",
      502,
      "SAOMIGUEL_INVALID_RESPONSE",
      response.status,
    );
  }
}

async function request(path: string, init: RequestInit & { headers: Record<string, string> }) {
  const configuration = saoMiguelConfiguration();
  if (!configuration.configured) throw configurationError();

  let response: Response;
  try {
    await waitForRequestSlot();
    response = await fetchWithRetry(`${configuration.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
    }, { timeoutMs: REQUEST_TIMEOUT_MS, attempts: 1 });
  } catch (error) {
    if (error instanceof SaoMiguelApiError) throw error;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new SaoMiguelApiError(
      timedOut
        ? "A Expresso São Miguel não respondeu a tempo."
        : "Não foi possível alcançar a Expresso São Miguel.",
      502,
      timedOut ? "SAOMIGUEL_TIMEOUT" : "SAOMIGUEL_UNAVAILABLE",
    );
  }

  if (response.status === 204) {
    // Documentado no manual (seção 3.3): 200 = comprovante encontrado,
    // 204 = id sem registro. Sem este branch, o corpo vazio seria lido
    // como payload nulo e normalizeSaoMiguelComprovante() devolveria
    // "success:true" com 0 fotos — parecendo um comprovante real sem
    // fotos, em vez de "este id não existe".
    throw new SaoMiguelApiError(
      "A Expresso São Miguel não possui registro para este comprovante.",
      404,
      "SAOMIGUEL_PROOF_NOT_FOUND",
      204,
    );
  }

  if (response.status === 401) {
    // O manual documenta que a mesma resposta 401 cobre "chave inválida" E
    // "limite de requisições por minuto excedido" — não dá para diferenciar
    // pela API. Reportamos como código de negócio distinto para a UI não
    // desligar a integração achando que a credencial expirou.
    throw new SaoMiguelApiError(
      "Chave de acesso inválida ou limite de requisições por minuto excedido na Expresso São Miguel.",
      401,
      "SAOMIGUEL_UNAUTHORIZED_OR_RATE_LIMITED",
      401,
    );
  }

  if (response.status === 429) {
    cooldownUntil = Date.now() + Math.max(60_000, retryAfterMs(response.headers.get("retry-after")));
    // A API real também devolve 429 puro quando o limite de requisições por
    // minuto é excedido, além do 401 documentado no manual. Distinguimos
    // para não confundir com "documento sem ocorrência" (404) na tela.
    throw new SaoMiguelApiError(
      "Limite de requisições por minuto excedido na Expresso São Miguel. O portal tentará novamente na próxima atualização.",
      429,
      "SAOMIGUEL_RATE_LIMITED",
      429,
    );
  }

  if (!response.ok) {
    throw new SaoMiguelApiError(
      `A Expresso São Miguel respondeu com HTTP ${response.status}.`,
      response.status >= 500 ? 502 : response.status,
      "SAOMIGUEL_REQUEST_FAILED",
      response.status,
    );
  }

  return readJson(response);
}

export async function trackingRequest(modeloConsulta: string, valoresParametros: unknown[]) {
  const configuration = saoMiguelConfiguration();
  if (!configuration.configured) throw configurationError();

  return request("/tracking", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Access_Key: configuration.accessKey,
      Customer: configuration.customer,
      Modelo_Consulta: modeloConsulta,
    },
    body: JSON.stringify({ valoresParametros }),
  });
}

export async function comprovanteRequest(idComprovante: string) {
  const configuration = saoMiguelConfiguration();
  if (!configuration.configured) throw configurationError();

  return request(`/comprovante/${encodeURIComponent(idComprovante)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ACCESS_KEY: configuration.accessKey,
      Customer: configuration.customer,
    },
  });
}

function normalizeEvent(value: unknown) {
  const event = asObject(value);
  if (!event) return null;

  // codigoProceda no dado real (ex.: "99", "00", "98", "01") não bate com
  // os seis exemplos do manual (AC/ET/ED/CO/TR/EN) — por isso repassamos a
  // descrição como fonte de verdade e guardamos o código só como referência.
  const description = asText(event.descricaoOcorrencia) || "Atualização Expresso São Miguel";
  // O manual mostra um exemplo com "T" duplicado em prevEntrega
  // ("...TT00:00..."); a mesma falha pode aparecer em dataRegistro/`data`,
  // então normalizamos aqui antes de repassar para o portal.
  const date = fixDuplicatedT(asText(event.data) || asText(event.dataRegistro));

  return {
    codigo: asText(event.codigoProceda),
    ocorrencia: description,
    tipo: description,
    descricao: description,
    data_hora: date,
    data_hora_efetiva: date,
    cidade: "",
    filial: "",
    idComprovante: asText(event.idComprovante) || undefined,
  };
}

function fixDuplicatedT(value: string): string {
  return value.replace(/T{2,}/, "T");
}

function selectSaoMiguelDocument(payload: unknown, decoded: NonNullable<ReturnType<typeof decodeAccessKey>>, accessKey: string) {
  const root = asObject(payload);
  const nested = root?.data ?? root?.resultado ?? root?.documentos ?? root?.items;
  const list = Array.isArray(payload) ? payload : Array.isArray(nested) ? nested : asObject(nested) ? [nested] : root ? [root] : [];
  const documents = list.map(asObject).filter((document): document is JsonObject => Boolean(document));

  if (!documents.length) {
    throw new SaoMiguelApiError(
      "A Expresso São Miguel não retornou ocorrências para este documento.",
      404,
      "SAOMIGUEL_NOT_FOUND",
    );
  }

  const matches = documents.filter(document => {
    const references = decoded.model === "55"
      ? (Array.isArray(document.notasFiscais) ? document.notasFiscais : [document.notaFiscal]).map(asObject).filter((item): item is JsonObject => Boolean(item))
      : [document];
    return references.some(reference => {
      const responseKey = digits(reference.chaveCTe ?? reference.chaveCte ?? reference.chaveNFe ?? reference.chave);
      if (responseKey.length === 44) return responseKey === digits(accessKey);
      const number = reference.numero ?? reference.numeroConhecimento ?? reference.numeroCTe ?? reference.numeroCte ?? reference.numeroNotaFiscal;
      const series = reference.serie ?? reference.serieConhecimento ?? reference.serieCTe ?? reference.serieCte;
      const numberDigits = digits(number);
      return Boolean(numberDigits) && Number(numberDigits) === decoded.number && (series == null || series === "" || Number(series) === decoded.series);
    });
  });
  if (!matches.length && documents.length === 1) {
    const document = documents[0];
    const visibleNumber = document.numero ?? document.numeroConhecimento ?? document.numeroCTe ?? document.numeroCte;
    const visibleKey = digits(document.chaveCTe ?? document.chaveCte ?? document.chaveNFe ?? document.chave);
    // Algumas versões devolvem um único conteúdo sem repetir número/série.
    // Como a consulta já usou número+série exatos, ele é seguro somente se
    // não houver uma identidade divergente explícita na resposta.
    if (visibleNumber == null && !visibleKey) return document;
  }
  if (matches.length !== 1) {
    throw new SaoMiguelApiError(
      matches.length > 1 ? "A São Miguel retornou mais de um documento compatível. O vínculo precisa ser confirmado pela transportadora." : "A São Miguel retornou um documento diferente do solicitado. Os eventos foram descartados.",
      502,
      "SAOMIGUEL_DOCUMENT_MISMATCH",
    );
  }
  return matches[0];
}

export function normalizeSaoMiguelTracking(payload: unknown, accessKey: string, decoded: ReturnType<typeof decodeAccessKey>) {
  if (!decoded || !["55", "57"].includes(decoded.model)) throw new SaoMiguelApiError("Chave de NF-e ou CT-e inválida.", 400, "SAOMIGUEL_INVALID_KEY");
  const document = selectSaoMiguelDocument(payload, decoded, accessKey);
  const rawEvents = Array.isArray(document.ocorrencias) ? document.ocorrencias : [];
  const tracking = rawEvents.map(normalizeEvent).filter((event): event is NonNullable<typeof event> => Boolean(event));

  const linkedNfes = Array.isArray(document.notasFiscais)
    ? (document.notasFiscais as unknown[]).map(asObject).filter((nfe): nfe is JsonObject => Boolean(nfe))
    : asObject(document.notaFiscal)
      ? [asObject(document.notaFiscal) as JsonObject]
      : [];

  const localEntrega = asObject(document.localEntrega);
  const cidadeEntrega = asObject(localEntrega?.cidade);
  const lastComprovante = [...tracking].reverse().find((event) => event.idComprovante);

  return {
    success: true,
    source: "SAOMIGUEL_API",
    provider: "Expresso São Miguel",
    carrier: "Expresso São Miguel",
    documento: {
      header: {
        ...(decoded.model === "57" ? { chave_cte: accessKey } : { chave_nfe: accessKey }),
        numero_documento: asText(document.numero),
        emissao: asText(document.dataEmissao),
        previsao_entrega: fixDuplicatedT(asText(document.prevEntrega)),
        valor_frete: document.valorFrete != null ? Number(document.valorFrete) : null,
        valor_mercadoria: document.valorMercadoria != null ? Number(document.valorMercadoria) : null,
        local_entrega: localEntrega
          ? {
              endereco: asText(localEntrega.endereco),
              numero: asText(localEntrega.numero),
              bairro: asText(localEntrega.bairro),
              cidade: asText(cidadeEntrega?.nome),
              uf: asText(cidadeEntrega?.uf),
            }
          : null,
        notas_fiscais: linkedNfes.map((nfe) => ({
          numero: asText(nfe.numero),
          serie: asText(nfe.serie),
          chave_nfe: asText(nfe.chaveNFe),
          valor: nfe.valor != null ? Number(nfe.valor) : null,
        })),
      },
      tracking,
    },
    comprovante: {
      disponivel: Boolean(lastComprovante?.idComprovante),
      idComprovante: lastComprovante?.idComprovante,
      quantidade: lastComprovante?.idComprovante ? 1 : 0,
    },
  };
}

export function normalizeSaoMiguelComprovante(payload: unknown) {
  const root = asObject(payload) || {};
  const pictures = Array.isArray(root.pictures) ? (root.pictures as unknown[]) : [];
  // O manual mostra um exemplo de longitude sem separador decimal
  // ("-526321525"); validamos a faixa (-180 a 180) em vez de confiar cego.
  const latitude = Number(root.latitude);
  const longitudeRaw = Number(root.longitude);
  const longitudeValid = Number.isFinite(longitudeRaw) && longitudeRaw >= -180 && longitudeRaw <= 180;

  return {
    success: true,
    comprovantes: pictures.map((picture, index) => ({
      downloadUrl: `data:image/jpeg;base64,${asText(picture)}`,
      originalName: `Comprovante ${index + 1} · Expresso São Miguel`,
      deliveryDate: null,
    })),
    geo: {
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: longitudeValid ? longitudeRaw : null,
      suspeita: !longitudeValid && root.longitude != null,
    },
  };
}
