import { NextRequest, NextResponse } from "next/server";
import { fetchWithRetry, integrationHealth, recordIntegrationCheck } from "@/lib/integration-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DocumentType = "nfe" | "cte";

const QIVE_ENDPOINTS: Record<DocumentType, string> = {
  nfe: "/v2/dfe/nfe",
  cte: "/v1/dfe/cte",
};

const DEFAULT_FIELDS = [
  "Xml",
  "AccessKey",
  "Number",
  "EmissionDate",
  "CreatedAt",
  "Owner",
  "OwnerRole",
  "Emitter",
  "Receiver",
  "Status",
  "Events",
  "Document",
];

function decodeDocumentXml(document: Record<string, unknown>) {
  const encodedXml = document.Xml || document.xml;
  if (typeof encodedXml !== "string" || !encodedXml) return "";
  if (encodedXml.trimStart().startsWith("<")) return encodedXml;

  try {
    const binary = atob(encodedXml);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function xmlValue(xml: string, tag: string) {
  if (!xml) return "";
  const match = xml.match(
    new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>\\s*([^<]+?)\\s*</`, "i"),
  );
  return match?.[1]?.trim() || "";
}

function xmlBlock(xml: string, tag: string) {
  if (!xml) return "";
  const match = xml.match(
    new RegExp(
      `<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}\\s*>`,
      "i",
    ),
  );
  return match?.[1] || "";
}

function xmlBlocks(xml: string, tag: string) {
  if (!xml) return [];
  return Array.from(
    xml.matchAll(
      new RegExp(
        `<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}\\s*>`,
        "gi",
      ),
    ),
    (match) => match[1] || "",
  );
}

function xmlValues(xml: string, tag: string) {
  if (!xml) return [];
  return Array.from(
    xml.matchAll(
      new RegExp(
        `<(?:[\\w-]+:)?${tag}\\b[^>]*>\\s*([^<]+?)\\s*<\\/(?:[\\w-]+:)?${tag}\\s*>`,
        "gi",
      ),
    ),
    (match) => match[1]?.trim() || "",
  ).filter(Boolean);
}

function extractXmlAddress(partyBlock: string, addressTags: string[]) {
  const addressBlock =
    addressTags.map((tag) => xmlBlock(partyBlock, tag)).find(Boolean) || partyBlock;

  return {
    street: xmlValue(addressBlock, "xLgr"),
    number: xmlValue(addressBlock, "nro"),
    complement: xmlValue(addressBlock, "xCpl"),
    district: xmlValue(addressBlock, "xBairro"),
    city: xmlValue(addressBlock, "xMun"),
    uf: xmlValue(addressBlock, "UF"),
    zipCode: xmlValue(addressBlock, "CEP"),
  };
}

function extractXmlParty(xml: string, partyTag: string, addressTags: string[]) {
  const partyBlock = xmlBlock(xml, partyTag);
  return {
    name: xmlValue(partyBlock, "xNome"),
    cnpj: xmlValue(partyBlock, "CNPJ") || xmlValue(partyBlock, "CPF"),
    address: extractXmlAddress(partyBlock, addressTags),
  };
}

function normalizeQuantity(value: string) {
  const normalized = value.trim().replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function extractCteQuantities(xml: string, structured: unknown) {
  const quantities = xmlBlocks(xml, "infQ").map((block) => ({
    unit: xmlValue(block, "cUnid").trim(),
    measure: xmlValue(block, "tpMed").trim().toLowerCase(),
    value: normalizeQuantity(xmlValue(block, "qCarga")),
  }));
  const weights = quantities
    .filter((item) => ["01", "02"].includes(item.unit) && item.value > 0)
    .map((item) => ({
      ...item,
      kilograms: item.unit === "02" ? item.value * 1000 : item.value,
    }));
  const realWeight =
    weights.find((item) => /real|bruto|base/.test(item.measure) && !/cub/.test(item.measure)) ||
    weights.find((item) => !/cub/.test(item.measure));
  const cubedWeight = weights.find((item) => /cub/.test(item.measure));
  const volumeQuantity = quantities.find((item) => item.unit === "03" && item.value > 0);

  return {
    weight:
      realWeight?.kilograms ||
      normalizeQuantity(
        findStructuredValue(structured, ["RealWeight", "GrossWeight", "WeightKg"]),
      ) ||
      "",
    cubedWeight:
      cubedWeight?.kilograms ||
      normalizeQuantity(findStructuredValue(structured, ["CubedWeight", "PesoCubado"])) ||
      "",
    volumes:
      volumeQuantity?.value ||
      normalizeQuantity(findStructuredValue(structured, ["Volumes", "VolumeQuantity"])) ||
      "",
  };
}

function findStructuredValue(value: unknown, keys: string[]): string {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStructuredValue(entry, keys);
      if (found) return found;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      return String(entry);
    }
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findStructuredValue(entry, keys);
    if (found) return found;
  }
  return "";
}

function findStructuredObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStructuredObject(entry, keys);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) &&
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry)
    ) {
      return entry as Record<string, unknown>;
    }
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findStructuredObject(entry, keys);
    if (found) return found;
  }

  return null;
}

function collectStructuredValues(value: unknown, keys: string[], result: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStructuredValues(entry, keys, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase()) &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      result.push(String(entry).trim());
    }
    if (entry && typeof entry === "object") collectStructuredValues(entry, keys, result);
  }
  return result;
}

function normalizePurchaseOrder(value: string) {
  const normalized = value
    .replace(/&(?:amp;|quot;|apos;|lt;|gt;)/gi, " ")
    .replace(/^[#:\s.\/-]+|[#:\s.,;\/-]+$/g, "")
    .trim();
  if (!/\d/.test(normalized) || normalized.replace(/\D/g, "").length === 44) return "";
  return normalized.slice(0, 60);
}

function ordersFromAdditionalInformation(text: string) {
  const orders: string[] = [];
  const pattern = /(?:n[uú]mero\s+d[oe]\s+pedido|n(?:[º°o.]|ro)?\s+d[oe]\s+pedido|pedido(?:\s+(?:(?:de|do|da)\s+)?(?:compra|venda|cliente|fornecedor))?|ordem\s+de\s+(?:compra|venda)|purchase\s+order|order\s+(?:number|no\.?|#)|p\.?o\.?|o\.?c\.?|p\.?c\.?|p\.?v\.?|ped\.?)\s*(?:n(?:[º°o.]|ro|[úu]mero)?\s*)?[:#=\-]?\s*([a-z0-9][a-z0-9._\/-]{1,59})/gi;
  for (const match of text.matchAll(pattern)) {
    const order = normalizePurchaseOrder(match[1] || "");
    if (order) orders.push(order);
  }
  return orders;
}

function extractNfePurchaseOrders(document: Record<string, unknown>) {
  const xml = decodeDocumentXml(document);
  const structured = document.Document || document.document;
  const found = new Map<string, { number: string; item: string; source: string }>();
  const add = (number: string, item: string, source: string) => {
    const normalized = normalizePurchaseOrder(number);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!found.has(key)) found.set(key, { number: normalized, item, source });
  };

  for (const detail of xmlBlocks(xml, "det")) {
    const product = xmlBlock(detail, "prod") || detail;
    const order = xmlValue(product, "xPed");
    const orderItem = xmlValue(product, "nItemPed");
    const itemMatch = detail.match(/\bnItem\s*=\s*["']([^"']+)["']/i);
    add(order, orderItem || itemMatch?.[1] || "", "xPed");
  }

  xmlValues(xml, "xPed").forEach((order) => add(order, "", "xPed"));

  const orderFields = [
    "xPed",
    "PurchaseOrder",
    "PurchaseOrderNumber",
    "OrderNumber",
    "CustomerOrder",
    "PedidoCompra",
    "NumeroPedido",
    "NumeroPedidoCompra",
    "NumPedido",
    "nPedido",
  ];
  collectStructuredValues(structured, orderFields).forEach((order) => add(order, "", "xPed"));
  orderFields.forEach((key) => {
    const value = document[key];
    if (typeof value === "string" || typeof value === "number") add(String(value), "", "xPed");
  });

  const notes = [
    ...xmlValues(xml, "infCpl"),
    ...xmlValues(xml, "infAdFisco"),
    ...xmlValues(xml, "xTexto"),
    ...xmlValues(xml, "xObs"),
    ...collectStructuredValues(structured, [
      "infCpl",
      "infAdFisco",
      "AdditionalInformation",
      "AdditionalInfo",
      "ComplementaryInformation",
      "InformacoesComplementares",
      "InformacoesAdicionais",
      "Observacao",
      "Observacoes",
      "Observation",
      "Observations",
      "xTexto",
      "xObs",
    ]),
  ];
  notes.flatMap(ordersFromAdditionalInformation).forEach((order) => add(order, "", "observacoes"));

  const entries = Array.from(found.values());
  return {
    numbers: entries.map((entry) => entry.number),
    entries,
    identified: entries.length > 0,
    source: entries.some((entry) => entry.source === "xPed")
      ? "xPed"
      : entries.length
        ? "observacoes"
        : "nao_identificado",
  };
}

function extractNfeOperationalData(document: Record<string, unknown>) {
  const xml = decodeDocumentXml(document);
  const structured = document.Document || document.document;
  const sender = extractXmlParty(xml, "emit", ["enderEmit"]);
  const recipient = extractXmlParty(xml, "dest", ["enderDest"]);
  const explicitDelivery = extractXmlParty(xml, "entrega", []);
  const structuredDelivery = findStructuredObject(structured, [
    "entrega",
    "Delivery",
    "DeliveryAddress",
    "DeliveryLocation",
  ]);
  const structuredAddress = structuredDelivery
    ? {
        street: findStructuredValue(structuredDelivery, ["xLgr", "Street", "Logradouro"]),
        number: findStructuredValue(structuredDelivery, ["nro", "Number", "Numero"]),
        complement: findStructuredValue(structuredDelivery, ["xCpl", "Complement"]),
        district: findStructuredValue(structuredDelivery, ["xBairro", "District", "Bairro"]),
        city: findStructuredValue(structuredDelivery, ["xMun", "City", "Municipio"]),
        uf: findStructuredValue(structuredDelivery, ["UF", "State"]),
        zipCode: findStructuredValue(structuredDelivery, ["CEP", "ZipCode"]),
      }
    : extractXmlAddress("", []);
  const explicitAddress = explicitDelivery.address;
  const hasExplicitDelivery = Boolean(
    explicitDelivery.cnpj ||
      explicitDelivery.name ||
      explicitAddress.street ||
      explicitAddress.city,
  );
  const hasStructuredDelivery = Boolean(structuredAddress.street || structuredAddress.city);
  const delivery = hasExplicitDelivery
    ? explicitAddress
    : hasStructuredDelivery
      ? structuredAddress
      : recipient.address;

  return {
    sender,
    recipient,
    delivery,
    deliveryParty: {
      name:
        explicitDelivery.name ||
        (structuredDelivery
          ? findStructuredValue(structuredDelivery, ["xNome", "Name", "RazaoSocial"])
          : "") ||
        recipient.name,
      cnpj:
        explicitDelivery.cnpj ||
        (structuredDelivery
          ? findStructuredValue(structuredDelivery, ["CNPJ", "CPF", "Document"])
          : "") ||
        recipient.cnpj,
      address: delivery,
    },
    deliverySource: hasExplicitDelivery
      ? "Local de entrega da NF-e · Qive"
      : hasStructuredDelivery
        ? "Endereço de entrega da NF-e · Qive"
        : "Destinatário da NF-e · Qive",
  };
}

function extractCteOperationalData(document: Record<string, unknown>) {
  const xml = decodeDocumentXml(document);
  const structured = document.Document || document.document;
  const quantities = extractCteQuantities(xml, structured);
  const read = (tag: string, aliases: string[] = []) =>
    xmlValue(xml, tag) || findStructuredValue(structured, [tag, ...aliases]);
  const sender = extractXmlParty(xml, "rem", ["enderReme"]);
  const expedition = extractXmlParty(xml, "exped", ["enderExped"]);
  const recipient = extractXmlParty(xml, "dest", ["enderDest"]);
  const receiver = extractXmlParty(xml, "receb", ["enderReceb"]);
  const deliveryParty =
    receiver.cnpj || receiver.name || receiver.address.city ? receiver : recipient;
  const taker3Block = xmlBlock(xml, "toma3");
  const taker4Block = xmlBlock(xml, "toma4");
  const takerCode = xmlValue(taker4Block, "toma") || xmlValue(taker3Block, "toma");
  const takerByCode: Record<
    string,
    { label: string; party: ReturnType<typeof extractXmlParty> }
  > = {
    "0": { label: "Remetente", party: sender },
    "1": { label: "Expedidor", party: expedition },
    "2": { label: "Recebedor", party: receiver },
    "3": { label: "Destinatário", party: recipient },
  };
  const mappedTaker = takerByCode[takerCode];
  const freightPayer = taker4Block
    ? {
        code: takerCode || "4",
        role: "Outros",
        name: xmlValue(taker4Block, "xNome"),
        cnpj: xmlValue(taker4Block, "CNPJ") || xmlValue(taker4Block, "CPF"),
        address: extractXmlAddress(taker4Block, ["enderToma"]),
        source: "toma4",
      }
    : mappedTaker
      ? {
          code: takerCode,
          role: mappedTaker.label,
          ...mappedTaker.party,
          source: "toma3",
        }
      : {
          code: "",
          role: "Não identificado",
          name: "",
          cnpj: "",
          address: extractXmlAddress("", []),
          source: "",
        };

  return {
    series: read("serie", ["Series"]),
    origin: {
      city: read("xMunIni", ["OriginCity"]) || sender.address.city,
      uf: read("UFIni", ["OriginUf"]) || sender.address.uf,
    },
    destination: {
      city: read("xMunFim", ["DestinationCity"]) || deliveryParty.address.city,
      uf: read("UFFim", ["DestinationUf"]) || deliveryParty.address.uf,
    },
    sender,
    expedition,
    recipient,
    receiver,
    freightPayer,
    delivery: deliveryParty.address,
    deliverySource:
      deliveryParty === receiver ? "Recebedor do CT-e" : "Destinatário do CT-e",
    freightValue: read("vTPrest", ["TotalFreightValue"]),
    cargoValue: read("vCarga", ["CargoValue"]),
    weight: quantities.weight,
    cubedWeight: quantities.cubedWeight,
    volumes: quantities.volumes,
    predominantProduct: read("proPred", ["PredominantProduct"]),
    modal: read("modal", ["Modal"]),
  };
}

function nfeReferenceFromAccessKey(accessKey: string) {
  const key = accessKey.replace(/\D/g, "");
  const number = key.length === 44 ? key.slice(25, 34).replace(/^0+/, "") || "0" : "";
  const series = key.length === 44 ? key.slice(22, 25).replace(/^0+/, "") || "0" : "";
  return { accessKey, number, series };
}

function collectLinkedNfeKeys(
  document: Record<string, unknown>,
  ownAccessKey: string,
) {
  const keys = new Set<string>();
  const addMatches = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    for (const match of String(value).matchAll(/\d{44}/g)) {
      if (match[0] !== ownAccessKey) keys.add(match[0]);
    }
  };
  const inspectNfeFields = (value: unknown, path = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry) => inspectNfeFields(entry, path));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([key, entry]) =>
        inspectNfeFields(entry, `${path}.${key}`.toLowerCase()),
      );
      return;
    }
    if (path.includes("nfe")) addMatches(value);
  };

  const rawDocument = document.Document || document.document;
  if (rawDocument) inspectNfeFields(rawDocument);

  const xml = decodeDocumentXml(document);
  if (xml) {
    for (const match of xml.matchAll(
      /<(?:[\w-]+:)?(?:chNFe|refNFe)\b[^>]*>\s*(\d{44})\s*</gi,
    )) {
      if (match[1] !== ownAccessKey) keys.add(match[1]);
    }
  }

  return Array.from(keys);
}

function getQiveConfiguration() {
  const apiId = process.env.QIVE_API_ID?.trim();
  const apiKey = process.env.QIVE_API_KEY?.trim();
  const baseUrl = (
    process.env.QIVE_API_BASE_URL?.trim() || "https://api.arquivei.com.br"
  ).replace(/\/$/, "");

  return {
    apiId,
    apiKey,
    baseUrl,
    configured: Boolean(apiId && apiKey),
  };
}

function configuredHfsCnpjs() {
  const raw =
    process.env.TMS_HFS_CNPJS?.trim() ||
    process.env.HFS_CNPJS?.trim() ||
    process.env.HFS_CNPJ?.trim() ||
    "";

  return Array.from(
    new Set(
      raw
        .split(/[;,\s]+/)
        .map((value) => value.replace(/\D/g, ""))
        .filter((value) => value.length === 14),
    ),
  );
}

function lastDayOfMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeDocuments(payload: unknown, type: DocumentType) {
  if (!payload || typeof payload !== "object") return [];

  const data = payload as Record<string, unknown>;
  const candidates =
    type === "nfe"
      ? [data.Nfes, data.nfes, data.Documents, data.documents, data.data]
      : [data.Ctes, data.CTes, data.ctes, data.Documents, data.documents, data.data];

  return candidates.find(Array.isArray) as unknown[] | undefined;
}

function normalizeDocument(item: unknown, type: DocumentType) {
  if (!item || typeof item !== "object") return item;

  const document = item as Record<string, unknown>;
  const emitter = (document.Emitter || document.emitter || {}) as Record<string, unknown>;
  const receiver = (document.Receiver || document.receiver || {}) as Record<string, unknown>;
  const accessKey = String(
    document.AccessKey || document.access_key || document.accessKey || "",
  );
  const linkedNfeKeys = collectLinkedNfeKeys(document, accessKey);
  const linkedNfes = linkedNfeKeys.map(nfeReferenceFromAccessKey);
  const operational =
    type === "cte"
      ? extractCteOperationalData(document)
      : extractNfeOperationalData(document);
  const purchaseOrder = extractNfePurchaseOrders(document);
  const xml = decodeDocumentXml(document);
  const carrierXml = xmlBlock(xml, "emit");
  const documentEvents = document.Events || document.events;

  return {
    accessKey,
    number: document.Number || document.number || document.DocumentNumber || "",
    emissionDate:
      document.EmissionDate || document.emission_date || document.emissionDate || "",
    createdAt: document.CreatedAt || document.created_at || document.createdAt || "",
    owner: document.Owner || document.owner || "",
    ownerRole: document.OwnerRole || document.owner_role || document.ownerRole || "",
    status: document.Status || document.status || "",
    emitter: {
      name:
        emitter.EmitterName ||
        emitter.name ||
        emitter.emitter_name ||
        emitter.RazaoSocial ||
        xmlValue(carrierXml, "xNome") ||
        "",
      tradeName:
        emitter.TradeName ||
        emitter.trade_name ||
        emitter.NomeFantasia ||
        xmlValue(carrierXml, "xFant") ||
        "",
      cnpj:
        emitter.EmitterCnpj ||
        emitter.cnpj ||
        emitter.emitter_cnpj ||
        xmlValue(carrierXml, "CNPJ") ||
        "",
      uf:
        emitter.EmitterAddressUf ||
        emitter.uf ||
        emitter.address_uf ||
        xmlValue(xmlBlock(carrierXml, "enderEmit"), "UF") ||
        "",
    },
    receiver: {
      name:
        receiver.ReceiverName || receiver.name || receiver.receiver_name || receiver.RazaoSocial || "",
      cnpj: receiver.ReceiverCnpj || receiver.cnpj || receiver.receiver_cnpj || "",
      uf: receiver.ReceiverAddressUf || receiver.uf || receiver.address_uf || "",
    },
    eventCount: Array.isArray(documentEvents) ? documentEvents.length : 0,
    events: Array.isArray(documentEvents) ? documentEvents : [],
    hasDocument: Boolean(document.Document || document.document),
    hasXml: Boolean(xml),
    linkedNfeKeys,
    linkedNfes,
    linkedNfeCount: linkedNfeKeys.length,
    operational,
    purchaseOrder,
  };
}

export async function GET() {
  const configuration = getQiveConfiguration();

  return NextResponse.json({
    configured: configuration.configured,
    environment: configuration.baseUrl.includes("sandbox") ? "sandbox" : "production",
    supportedDocuments: ["nfe", "cte"],
    trackingRules: {
      excludedCarrierCnpjs: configuredHfsCnpjs(),
    },
    ...integrationHealth("qive"),
  });
}

export async function POST(request: NextRequest) {
  const configuration = getQiveConfiguration();

  if (!configuration.configured) {
    return NextResponse.json(
      {
        success: false,
        code: "QIVE_CONFIGURATION_REQUIRED",
        message:
          "As credenciais QIVE_API_ID e QIVE_API_KEY ainda não estão configuradas no servidor.",
      },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const documentType = String(body?.documentType || "nfe").toLowerCase() as DocumentType;
  const month = String(body?.month || "");
  const requestedFrom = String(body?.from || "");
  const requestedTo = String(body?.to || "");
  const owner = String(body?.owner || "").replace(/\D/g, "");
  const paginator = typeof body?.paginator === "string" ? body.paginator : undefined;
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 100);

  if (!(documentType in QIVE_ENDPOINTS)) {
    return NextResponse.json(
      { success: false, message: "Tipo de documento inválido. Use nfe ou cte." },
      { status: 400 },
    );
  }

  const hasCustomPeriod = Boolean(requestedFrom || requestedTo);
  if (
    (hasCustomPeriod &&
      (!isValidIsoDate(requestedFrom) ||
        !isValidIsoDate(requestedTo) ||
        requestedFrom > requestedTo)) ||
    (!hasCustomPeriod && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
  ) {
    return NextResponse.json(
      {
        success: false,
        message: hasCustomPeriod
          ? "Informe datas inicial e final válidas no formato AAAA-MM-DD."
          : "Informe uma competência válida no formato AAAA-MM.",
      },
      { status: 400 },
    );
  }

  if (owner && owner.length !== 14) {
    return NextResponse.json(
      { success: false, message: "O CNPJ da filial deve conter 14 dígitos." },
      { status: 400 },
    );
  }

  const from = hasCustomPeriod ? requestedFrom : `${month}-01`;
  const to = hasCustomPeriod
    ? requestedTo
    : `${month}-${String(lastDayOfMonth(month)).padStart(2, "0")}`;
  const filters: Record<string, unknown> = {
    EmissionDate: {
      From: `${from} 00:00:00`,
      To: `${to} 23:59:59`,
    },
  };

  if (owner) filters.Owners = [owner];

  const qiveBody: Record<string, unknown> = {
    fields: DEFAULT_FIELDS,
    Filters: filters,
    Limit: limit,
  };

  if (paginator) qiveBody.paginator = paginator;

  const startedAt = Date.now();

  try {
    const response = await fetchWithRetry(
      `${configuration.baseUrl}${QIVE_ENDPOINTS[documentType]}`,
      {
        method: "POST",
        headers: {
          "X-API-ID": configuration.apiId!,
          "X-API-KEY": configuration.apiKey!,
          "X-Use-ApiGateway": "always",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(qiveBody),
        cache: "no-store",
      },
    );

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      const qiveMessage =
        payload && typeof payload === "object"
          ? String(
              (payload as Record<string, unknown>).message ||
                (payload as Record<string, unknown>).error ||
                "",
            )
          : "";

      recordIntegrationCheck("qive", false, "QIVE_REQUEST_FAILED");
      return NextResponse.json(
        {
          success: false,
          code: "QIVE_REQUEST_FAILED",
          message:
            qiveMessage ||
            `A Qive respondeu com HTTP ${response.status}. Verifique acesso, CNPJs e limite contratado.`,
        },
        { status: response.status || 502 },
      );
    }

    const rawDocuments = normalizeDocuments(payload, documentType) || [];
    const responseData = payload as Record<string, unknown>;

    recordIntegrationCheck("qive", true);
    return NextResponse.json({
      success: true,
      documentType,
      period: { from, to },
      documents: rawDocuments.map((document) => normalizeDocument(document, documentType)),
      total: Number(responseData.Total || responseData.total || rawDocuments.length),
      paginator:
        responseData.Paginator ||
        responseData.paginator ||
        (responseData.page as Record<string, unknown> | undefined)?.next ||
        null,
      rateLimit: {
        limit: response.headers.get("x-ratelimit-limit"),
        remaining: response.headers.get("x-ratelimit-remaining"),
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    recordIntegrationCheck("qive", false, timedOut ? "QIVE_TIMEOUT" : "QIVE_UNAVAILABLE");
    return NextResponse.json(
      {
        success: false,
        code: timedOut ? "QIVE_TIMEOUT" : "QIVE_UNAVAILABLE",
        message: timedOut
          ? "A consulta à Qive excedeu o tempo limite. O portal tentará novamente na próxima atualização."
          : "Não foi possível alcançar a API da Qive neste momento.",
      },
      { status: 502 },
    );
  }
}
