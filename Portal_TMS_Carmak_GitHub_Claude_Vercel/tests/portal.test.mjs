import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const portalUrl = new URL("../public/portal.html", import.meta.url);

test("preserva filtros operacionais e painel real de transportadoras", async () => {
  const portal = await readFile(portalUrl, "utf8");

  for (const identifier of [
    "trackingDateFrom",
    "trackingDateTo",
    "trackingBranchFilter",
    "trackingCarrierFilter",
    "trackingCoverageFilter",
    "trackingSswConfirmed",
    "trackingIdentifiedOrders",
  ]) {
    assert.match(portal, new RegExp(`id="${identifier}"`));
  }

  assert.match(portal, /Terceiro paga/);
  assert.match(portal, /Somente máquinas completas/);
  assert.match(portal, /Estrela Vermelha/);
  assert.doesNotMatch(portal, /Rastrear SSW/);
});

test("descobre transportadoras SSW e confirma somente ocorrências reais", async () => {
  const portal = await readFile(portalUrl, "utf8");
  const start = portal.indexOf("function digits(value)");
  const end = portal.indexOf("function carrierRecord(doc)", start);
  assert.ok(start > 0 && end > start);

  const context = {
    TRACKING_REFRESH_MS: 15 * 60 * 1000,
    TRACKING_MAX_CARRIER_CHECKS: 90,
    TRACKING_DISCOVERY_SAMPLE_PER_CARRIER: 3,
    qiveOwner: {
      options: [{ value: "94534237000600", textContent: "Sumaré/SP · 0006" }],
    },
    qiveTracking: {
      nfeByKey: new Map(),
      excludedCarrierCnpjs: [],
      twConfigured: true,
      sswConfigured: true,
      saomiguelConfigured: true,
      modularConfigured: true,
      sswDiscovery: true,
      sswCarriers: ["Adonai", "União", "Estrela Vermelha"],
      carrierEvents: new Map(),
      carrierErrors: new Map(),
      carrierChecks: new Map(),
    },
    document: { getElementById: () => ({ value: "all" }) },
  };

  runInNewContext(
    `${portal.slice(start, end)}\n` +
      "globalThis.helpers = { carrierTrackingConnector, carrierTrackingOverview, " +
      "carrierHasConfirmedTracking, trackingCarrierMatchesResponse, " +
      "cargoClassification, isExcludedHfsCarrier };",
    context,
  );

  const transportadora = {
    accessKey: "1".repeat(44),
    emitter: { name: "TRANSDUARTE TRANSPORTES", cnpj: "22888888000190" },
    linkedNfeKeys: ["2".repeat(44)],
    operational: {},
  };

  assert.equal(context.helpers.carrierTrackingConnector(transportadora).mode, "discovery");
  assert.equal(context.helpers.carrierTrackingOverview([transportadora])[0].sswTracked, 0);

  context.qiveTracking.carrierEvents.set(transportadora.accessKey, {
    source: "SSW_API",
    events: [{ ocorrencia: "Mercadoria em transferência" }],
  });

  const profile = context.helpers.carrierTrackingOverview([transportadora])[0];
  assert.equal(profile.sswTracked, 1);
  assert.equal(profile.label, "SSW confirmado");
  assert.equal(
    context.helpers.trackingCarrierMatchesResponse(transportadora, {
      cnpj_transportadora: "33999999000180",
    }),
    false,
  );

  assert.equal(
    context.helpers.cargoClassification({
      operational: { predominantProduct: "GARFO DE EMPILHADEIRA" },
    }).kind,
    "general",
  );

  const saoMiguel = {
    accessKey: "3".repeat(44),
    emitter: { name: "EXPRESSO SAO MIGUEL TRANSPORTES", cnpj: "94534237000104" },
    linkedNfeKeys: ["4".repeat(44)],
    operational: {},
  };

  const connector = context.helpers.carrierTrackingConnector(saoMiguel);
  assert.equal(connector.key, "saomiguel");
  assert.equal(connector.endpoint, "/api/saomiguel/rastreio");
  assert.equal(connector.mode, "configured");
  assert.equal(context.helpers.carrierTrackingOverview([saoMiguel])[0].label, "São Miguel configurada");

  context.qiveTracking.carrierEvents.set(saoMiguel.accessKey, {
    source: "SAOMIGUEL_API",
    events: [{ ocorrencia: "Emissão do conhecimento de frete" }],
  });

  const saoMiguelProfile = context.helpers.carrierTrackingOverview([saoMiguel])[0];
  assert.equal(saoMiguelProfile.sswTracked, 0);
  assert.equal(saoMiguelProfile.label, "Eventos confirmados");

  const modular = {
    accessKey: "5".repeat(44),
    emitter: { name: "MODULAR TRANSPORTES LTDA", cnpj: "11222333000144" },
    linkedNfeKeys: ["6".repeat(44)],
    operational: {},
  };

  const modularConnector = context.helpers.carrierTrackingConnector(modular);
  assert.equal(modularConnector.key, "modular");
  assert.equal(modularConnector.endpoint, "/api/modular/rastreio");
  assert.equal(context.helpers.carrierTrackingOverview([modular])[0].label, "Modular configurada");
});

test("todo campo disponível nos Relatórios corresponde a uma coluna real", async () => {
  const portal = await readFile(portalUrl, "utf8");
  const fieldLabels = Array.from(
    portal.matchAll(/<div class="field-row" data-field="([^"]+)">/g),
  ).map((match) => match[1]);
  assert.ok(fieldLabels.length >= 20, "esperava encontrar a lista de campos disponíveis");

  const start = portal.indexOf("const reportColumns=");
  const end = portal.indexOf("function qiveReportData");
  assert.ok(start > 0 && end > start);

  const context = {};
  runInNewContext(`${portal.slice(start, end)}\nglobalThis.helpers = { reportFieldKey };`, context);

  for (const label of fieldLabels) {
    assert.notEqual(
      context.helpers.reportFieldKey(label),
      "",
      `o campo "${label}" não corresponde a nenhuma coluna em reportColumns/reportFieldAliases`,
    );
  }
});

test("preserva integrações fiscais e mantém rotas dinâmicas no servidor", async () => {
  for (const route of [
    "../app/api/qive/documents/route.ts",
    "../app/api/ssw/rastreio/route.ts",
    "../app/api/tw/rastreio/route.ts",
    "../app/api/saomiguel/rastreio/route.ts",
    "../app/api/saomiguel/comprovantes/route.ts",
    "../app/api/modular/rastreio/route.ts",
    "../app/api/modular/empresas/route.ts",
    "../app/api/modular/comprovantes/route.ts",
  ]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.match(source, /export const runtime = "nodejs"/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_(?:QIVE|SSW|TW)/);
  }
});
