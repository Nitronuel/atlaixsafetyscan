import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || process.env.INSIGHTX_ENGINE_PORT || 3101);
const HOST = process.env.HOST || '0.0.0.0';
const INSIGHTX_API_BASE_URL = 'https://api.insightx.network';
const INSIGHTX_TIMEOUT_MS = 18_000;
const INSIGHTX_DEFAULT_CACHE_TTL_MS = 3 * 60_000;
const INSIGHTX_LABEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const INSIGHTX_SUPPORTED_NETWORKS = new Set(['sol', 'eth', 'base', 'bsc', 'monad', 'xlayer', 'abs', 'sui']);
const insightXCache = new Map<string, { expiresAt: number; value: unknown; cachedAt: string }>();

type InsightXEndpointStatus = 'available' | 'unsupported' | 'missing' | 'error' | 'rate_limited' | 'not_configured';

type InsightXEndpointResult = {
  status: InsightXEndpointStatus;
  data: unknown | null;
  error?: string;
  httpStatus?: number;
  cached?: boolean;
  cachedAt?: string;
  fetchedAt: string;
  retryAfter?: string | null;
};

type InsightXFetchOptions = {
  path: string;
  params?: Record<string, string | number | null | undefined>;
  cacheKey: string;
  ttlMs?: number;
};

const INSIGHTX_REPORT_ENDPOINTS = [
  'scanner',
  'overview',
  'distribution',
  'clusters',
  'snipers',
  'bundlers',
  'insiders',
  'atlasLatest',
  'atlasTimestamps',
  'labels'
] as const;

type InsightXReportEndpointKey = typeof INSIGHTX_REPORT_ENDPOINTS[number];

function loadEnvFile(filename: string, override = false) {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) return;

  const lines = readFileSync(filepath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (override || !process.env[key]) process.env[key] = value;
  }
}

loadEnvFile('.env');
loadEnvFile('.env.local', true);

function readEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(JSON.stringify(payload));
}

function normalizeAddress(value: string) {
  return value.trim();
}

function normalizeInsightXNetwork(value: string | null | undefined) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ethereum') return 'eth';
  if (normalized === 'solana') return 'sol';
  if (normalized === 'bnb' || normalized === 'bnbchain') return 'bsc';
  return normalized;
}

function isLikelySolanaAddress(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function isLikelyEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function validateInsightXRequest(network: string, address: string) {
  if (!INSIGHTX_SUPPORTED_NETWORKS.has(network)) {
    throw new Error('Select a supported InsightX network.');
  }

  if (!address) {
    throw new Error('Enter a token or wallet address.');
  }

  if (network === 'sol' && !isLikelySolanaAddress(address)) {
    throw new Error('Solana requests require a valid Solana address.');
  }

  if (network !== 'sol' && network !== 'sui' && !isLikelyEvmAddress(address)) {
    throw new Error('This network requires a valid 0x address.');
  }
}

function getInsightXApiKey() {
  return readEnv('INSIGHTX_API_KEY');
}

function getInsightXCache(key: string) {
  const cached = insightXCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    insightXCache.delete(key);
    return null;
  }
  return cached;
}

async function fetchWithTimeout(input: URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInsightX(options: InsightXFetchOptions): Promise<InsightXEndpointResult> {
  const fetchedAt = new Date().toISOString();
  const apiKey = getInsightXApiKey();
  if (!apiKey) {
    return {
      status: 'not_configured',
      data: null,
      error: 'InsightX API key is not configured.',
      fetchedAt
    };
  }

  const cached = getInsightXCache(options.cacheKey);
  if (cached) {
    return {
      status: 'available',
      data: cached.value,
      cached: true,
      cachedAt: cached.cachedAt,
      fetchedAt
    };
  }

  const upstreamUrl = new URL(options.path, readEnv('INSIGHTX_API_BASE_URL') || INSIGHTX_API_BASE_URL);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== null && value !== undefined && String(value).trim()) {
      upstreamUrl.searchParams.set(key, String(value));
    }
  }

  try {
    const upstream = await fetchWithTimeout(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey
      }
    }, INSIGHTX_TIMEOUT_MS);
    const payload = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const detail = typeof payload?.detail === 'string'
        ? payload.detail
        : Array.isArray(payload?.detail)
          ? payload.detail.map((item: any) => item?.msg || item?.type).filter(Boolean).join(', ')
          : payload?.error || `InsightX request failed with status ${upstream.status}.`;

      return {
        status: upstream.status === 404 ? 'missing' : upstream.status === 429 ? 'rate_limited' : upstream.status === 422 || upstream.status === 501 ? 'unsupported' : 'error',
        data: null,
        error: detail || `InsightX request failed with status ${upstream.status}.`,
        httpStatus: upstream.status,
        retryAfter: upstream.headers.get('Retry-After'),
        fetchedAt
      };
    }

    insightXCache.set(options.cacheKey, {
      value: payload,
      cachedAt: fetchedAt,
      expiresAt: Date.now() + (options.ttlMs ?? INSIGHTX_DEFAULT_CACHE_TTL_MS)
    });

    return {
      status: 'available',
      data: payload,
      cached: false,
      fetchedAt
    };
  } catch (error) {
    return {
      status: 'error',
      data: null,
      error: error instanceof Error ? error.message : 'InsightX request failed.',
      fetchedAt
    };
  }
}

function collectInsightXLabelAddresses(
  addresses: Set<string>,
  endpoints: Partial<Record<InsightXReportEndpointKey, InsightXEndpointResult>>,
  cachedValues: unknown[] = []
) {
  const collectAddress = (value: unknown) => {
    const candidate = String(value || '').trim();
    if (candidate && addresses.size < 100) addresses.add(candidate);
  };

  const dataSources = [
    ...cachedValues,
    endpoints.scanner?.data,
    endpoints.snipers?.data,
    endpoints.bundlers?.data,
    endpoints.insiders?.data,
    endpoints.clusters?.data
  ];

  dataSources.forEach((data: any) => {
    const advanced = data?.results?.advanced || {};
    collectAddress(advanced?.creator?.address);
    [
      advanced?.top_holders,
      advanced?.multichain_top_holders,
      data?.snipers,
      data?.bundlers,
      data?.insiders
    ].forEach((source) => {
      if (Array.isArray(source)) {
        source.slice(0, 30).forEach((item) => collectAddress(item?.address || item));
      }
    });

    const clusters = Array.isArray(data?.clusters) ? data.clusters : Array.isArray(data) ? data : [];
    clusters.slice(0, 12).forEach((cluster: any) => {
      const members = Array.isArray(cluster?.members)
        ? cluster.members
        : Array.isArray(cluster?.wallets)
          ? cluster.wallets
          : Array.isArray(cluster?.cluster_addresses)
            ? cluster.cluster_addresses
            : [];
      members.slice(0, 8).forEach((item: any) => collectAddress(item?.address || item));
    });
  });
}

async function buildInsightXReport(network: string, address: string) {
  validateInsightXRequest(network, address);
  const encodedNetwork = encodeURIComponent(network);
  const encodedAddress = encodeURIComponent(address);
  const cacheBase = `${network}:${address.toLowerCase()}`;

  const requests: Partial<Record<InsightXReportEndpointKey, Promise<InsightXEndpointResult>>> = {
    scanner: fetchInsightX({ path: `/scanner/v1/tokens/${encodedNetwork}/${encodedAddress}`, cacheKey: `scanner:${cacheBase}` }),
    overview: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}`, cacheKey: `overview:${cacheBase}` }),
    distribution: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/distribution`, cacheKey: `distribution:${cacheBase}` }),
    clusters: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/clusters`, cacheKey: `clusters:${cacheBase}` }),
    snipers: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/snipers`, cacheKey: `snipers:${cacheBase}` }),
    bundlers: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/bundlers`, cacheKey: `bundlers:${cacheBase}` }),
    insiders: fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/insiders`, cacheKey: `insiders:${cacheBase}` }),
    atlasLatest: fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots/latest`, cacheKey: `atlas-latest:${cacheBase}` }),
    atlasTimestamps: fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots`, cacheKey: `atlas-timestamps:${cacheBase}` })
  };

  const entries = await Promise.all(Object.entries(requests).map(async ([key, promise]) => [key, await promise] as const));
  const endpoints = Object.fromEntries(entries) as Record<InsightXReportEndpointKey, InsightXEndpointResult>;

  const addresses = new Set<string>();
  collectInsightXLabelAddresses(addresses, endpoints);
  if (!addresses.size) addresses.add(address);
  await delay(2_000);
  endpoints.labels = await fetchInsightX({
    path: `/labels/v1/${encodedNetwork}/${encodeURIComponent([...addresses].join(','))}`,
    cacheKey: `labels:${network}:${[...addresses].sort().join(',').toLowerCase()}`,
    ttlMs: INSIGHTX_LABEL_CACHE_TTL_MS
  });

  return {
    network,
    address,
    generatedAt: new Date().toISOString(),
    source: 'insightx',
    endpoints
  };
}

async function handleInsightXRequest(response: ServerResponse, requestUrl: URL) {
  const network = normalizeInsightXNetwork(requestUrl.searchParams.get('network'));
  const address = normalizeAddress(requestUrl.searchParams.get('address') || requestUrl.searchParams.get('token') || '');
  const path = requestUrl.pathname;

  if (path === '/api/insightx/health') {
    json(response, 200, {
      configured: Boolean(getInsightXApiKey()),
      baseUrl: readEnv('INSIGHTX_API_BASE_URL') || INSIGHTX_API_BASE_URL,
      cacheEntries: insightXCache.size
    });
    return;
  }

  if (path === '/api/insightx/report') {
    try {
      json(response, 200, await buildInsightXReport(network, address));
      return;
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'Could not build InsightX report.' });
      return;
    }
  }

  try {
    validateInsightXRequest(network, address);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Invalid InsightX request.' });
    return;
  }

  const encodedNetwork = encodeURIComponent(network);
  const encodedAddress = encodeURIComponent(address);
  const cacheBase = `${network}:${address.toLowerCase()}`;
  let result: InsightXEndpointResult;

  if (path === '/api/insightx/scanner') {
    result = await fetchInsightX({ path: `/scanner/v1/tokens/${encodedNetwork}/${encodedAddress}`, cacheKey: `scanner:${cacheBase}` });
  } else if (path === '/api/insightx/dex-metrics') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}`, cacheKey: `overview:${cacheBase}` });
  } else if (path === '/api/insightx/distribution') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/distribution`, cacheKey: `distribution:${cacheBase}` });
  } else if (path === '/api/insightx/clusters') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/clusters`, cacheKey: `clusters:${cacheBase}` });
  } else if (path === '/api/insightx/snipers') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/snipers`, cacheKey: `snipers:${cacheBase}` });
  } else if (path === '/api/insightx/bundlers') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/bundlers`, cacheKey: `bundlers:${cacheBase}` });
  } else if (path === '/api/insightx/insiders') {
    result = await fetchInsightX({ path: `/dex-metrics/v1/${encodedNetwork}/${encodedAddress}/insiders`, cacheKey: `insiders:${cacheBase}` });
  } else if (path === '/api/insightx/atlas/latest') {
    result = await fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots/latest`, cacheKey: `atlas-latest:${cacheBase}` });
  } else if (path === '/api/insightx/atlas/timestamps') {
    result = await fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots`, cacheKey: `atlas-timestamps:${cacheBase}` });
  } else if (path === '/api/insightx/atlas/snapshot') {
    const timestamp = requestUrl.searchParams.get('timestamp') || '';
    result = await fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots/${encodeURIComponent(timestamp)}`, cacheKey: `atlas-snapshot:${cacheBase}:${timestamp}` });
  } else if (path === '/api/insightx/labels') {
    const addresses = (requestUrl.searchParams.get('addresses') || address).split(',').map((item) => item.trim()).filter(Boolean).slice(0, 100);
    result = await fetchInsightX({
      path: `/labels/v1/${encodedNetwork}/${encodeURIComponent(addresses.join(','))}`,
      cacheKey: `labels:${network}:${addresses.sort().join(',').toLowerCase()}`,
      ttlMs: INSIGHTX_LABEL_CACHE_TTL_MS
    });
  } else {
    json(response, 404, { error: 'InsightX endpoint not found.' });
    return;
  }

  json(response, result.status === 'available' ? 200 : result.httpStatus || 200, result);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if ((request.method || 'GET').toUpperCase() === 'OPTIONS') {
    json(response, 200, { ok: true });
    return;
  }

  if ((request.method || 'GET').toUpperCase() === 'GET' && requestUrl.pathname.startsWith('/api/insightx')) {
    await handleInsightXRequest(response, requestUrl);
    return;
  }

  json(response, 404, { error: 'Safety scan engine endpoint not found.' });
}

createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : 'Safety scan engine failed.' });
  });
}).listen(PORT, HOST, () => {
  console.log(`Safety scan engine listening on http://${HOST}:${PORT}`);
});
