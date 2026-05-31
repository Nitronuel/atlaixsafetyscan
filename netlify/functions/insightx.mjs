const INSIGHTX_API_BASE_URL = 'https://api.insightx.network';
const INSIGHTX_TIMEOUT_MS = 18_000;
const INSIGHTX_DEFAULT_CACHE_TTL_MS = 3 * 60_000;
const INSIGHTX_LABEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const INSIGHTX_SUPPORTED_NETWORKS = new Set(['sol', 'eth', 'base', 'bsc', 'monad', 'xlayer', 'abs', 'sui']);
const insightXCache = new Map();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

function normalizeInsightXNetwork(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ethereum') return 'eth';
  if (normalized === 'solana') return 'sol';
  if (normalized === 'bnb' || normalized === 'bnbchain') return 'bsc';
  return normalized;
}

function isLikelySolanaAddress(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || '').trim());
}

function isLikelyEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function validateInsightXRequest(network, address) {
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

function getInsightXCache(key) {
  const cached = insightXCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    insightXCache.delete(key);
    return null;
  }
  return cached;
}

async function fetchWithTimeout(input, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInsightX(options) {
  const fetchedAt = new Date().toISOString();
  const apiKey = process.env.INSIGHTX_API_KEY?.trim();
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

  const upstreamUrl = new URL(options.path, process.env.INSIGHTX_API_BASE_URL || INSIGHTX_API_BASE_URL);
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
          ? payload.detail.map((item) => item?.msg || item?.type).filter(Boolean).join(', ')
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

function getWalletAddress(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.address || value?.wallet || value?.owner || value?.account || '').trim();
}

function collectInsightXLabelAddresses(addresses, endpoints) {
  const collectAddress = (value) => {
    const candidate = getWalletAddress(value) || String(value || '').trim();
    if (candidate && addresses.size < 100) addresses.add(candidate);
  };

  [
    endpoints.scanner?.data,
    endpoints.snipers?.data,
    endpoints.bundlers?.data,
    endpoints.insiders?.data,
    endpoints.clusters?.data
  ].forEach((data) => {
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
        source.slice(0, 30).forEach((item) => collectAddress(item));
      }
    });

    const clusters = Array.isArray(data?.clusters) ? data.clusters : Array.isArray(data) ? data : [];
    clusters.slice(0, 12).forEach((cluster) => {
      const members = Array.isArray(cluster?.members)
        ? cluster.members
        : Array.isArray(cluster?.wallets)
          ? cluster.wallets
          : Array.isArray(cluster?.cluster_addresses)
            ? cluster.cluster_addresses
            : [];
      members.slice(0, 8).forEach((item) => collectAddress(item));
    });
  });
}

async function buildInsightXReport(network, address) {
  validateInsightXRequest(network, address);
  const encodedNetwork = encodeURIComponent(network);
  const encodedAddress = encodeURIComponent(address);
  const cacheBase = `${network}:${address.toLowerCase()}`;

  const requests = {
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

  const entries = await Promise.all(Object.entries(requests).map(async ([key, promise]) => [key, await promise]));
  const endpoints = Object.fromEntries(entries);

  const addresses = new Set();
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

function functionSubpath(event) {
  const path = event.path || '';
  const marker = '/.netlify/functions/insightx';
  const index = path.indexOf(marker);
  if (index >= 0) {
    return path.slice(index + marker.length) || '/';
  }
  return '/';
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method is not allowed.' });

  const params = event.queryStringParameters || {};
  const path = `/api/insightx${functionSubpath(event)}`;
  const network = normalizeInsightXNetwork(params.network);
  const address = String(params.address || params.token || '').trim();

  if (path === '/api/insightx/health') {
    return json(200, {
      configured: Boolean(process.env.INSIGHTX_API_KEY?.trim()),
      baseUrl: process.env.INSIGHTX_API_BASE_URL || INSIGHTX_API_BASE_URL,
      cacheEntries: insightXCache.size
    });
  }

  if (path === '/api/insightx/report') {
    try {
      return json(200, await buildInsightXReport(network, address));
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Could not build InsightX report.' });
    }
  }

  try {
    validateInsightXRequest(network, address);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid InsightX request.' });
  }

  const encodedNetwork = encodeURIComponent(network);
  const encodedAddress = encodeURIComponent(address);
  const cacheBase = `${network}:${address.toLowerCase()}`;
  let result;

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
    const timestamp = params.timestamp || '';
    result = await fetchInsightX({ path: `/atlas/v1/${encodedNetwork}/${encodedAddress}/snapshots/${encodeURIComponent(timestamp)}`, cacheKey: `atlas-snapshot:${cacheBase}:${timestamp}` });
  } else if (path === '/api/insightx/labels') {
    const addresses = String(params.addresses || address).split(',').map((item) => item.trim()).filter(Boolean).slice(0, 100);
    result = await fetchInsightX({
      path: `/labels/v1/${encodedNetwork}/${encodeURIComponent(addresses.join(','))}`,
      cacheKey: `labels:${network}:${addresses.sort().join(',').toLowerCase()}`,
      ttlMs: INSIGHTX_LABEL_CACHE_TTL_MS
    });
  } else {
    return json(404, { error: 'InsightX endpoint not found.' });
  }

  return json(result.status === 'available' ? 200 : result.httpStatus || 200, result);
}
