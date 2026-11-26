import type { ArtifactRow, Env, Visibility } from '../env';
import { getKeys } from './crypto';
import { isUuid } from './hosts';
import { clientIp, HttpError } from './http';

export type AnalyticsEvent = 'view' | 'download' | 'referral';
export type AnalyticsDevice = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'cli';
export type AnalyticsRange = '24h' | '7d' | '30d' | '90d';

export interface AnalyticsSeriesPoint {
  ts: number;
  views: number;
  visitors: number;
  downloads: number;
}

export interface AnalyticsTopArtifact {
  id: string;
  title: string;
  kind: ArtifactRow['kind'] | null;
  visibility: Visibility | null;
  deleted: boolean;
  views: number;
  visitors: number;
}

export type AnalyticsResponse =
  | { enabled: false }
  | {
      enabled: true;
      dataset_missing?: boolean;
      range: AnalyticsRange;
      bucket: 'hour' | 'day';
      totals: {
        views: number;
        visitors: number;
        downloads: number;
        views_90d: number;
      };
      series: AnalyticsSeriesPoint[];
      countries: Array<{ code: string; views: number }>;
      referrers: Array<{ host: string; count: number }>;
      devices: Array<{ type: AnalyticsDevice; views: number }>;
      paths?: Array<{ path: string; views: number }>;
      top_artifacts?: AnalyticsTopArtifact[];
    };

export type AnalyticsViewsResponse =
  | { enabled: false }
  | {
      enabled: true;
      dataset_missing?: boolean;
      window_days: 90;
      views: Record<string, number>;
    };

export const INTERNAL_REFERER = '(internal)';
const DEFAULT_DATASET = 'artifacts_share_events';
const DATASET_RE = /^[A-Za-z0-9_]{1,64}$/;
const VIEWS_WINDOW_DAYS = 90 as const;
const MAX_VIEWS_IDS = 100;
const RANGE_CONFIG: Record<AnalyticsRange, { stepSec: number; buckets: number; bucket: 'hour' | 'day' }> = {
  '24h': { stepSec: 3600, buckets: 24, bucket: 'hour' },
  '7d': { stepSec: 86400, buckets: 7, bucket: 'day' },
  '30d': { stepSec: 86400, buckets: 30, bucket: 'day' },
  '90d': { stepSec: 86400, buckets: 90, bucket: 'day' },
};

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const queryCache = new Map<string, { exp: number; data: Exclude<AnalyticsResponse, { enabled: false }> }>();
const inFlight = new Map<string, Promise<Exclude<AnalyticsResponse, { enabled: false }>>>();
const viewsCache = new Map<string, { exp: number; data: Exclude<AnalyticsViewsResponse, { enabled: false }> }>();
const viewsInFlight = new Map<string, Promise<Exclude<AnalyticsViewsResponse, { enabled: false }>>>();
const enc = new TextEncoder();

export function clearAnalyticsCache(): void {
  queryCache.clear();
  inFlight.clear();
  viewsCache.clear();
  viewsInFlight.clear();
}

export function analyticsEnabled(env: Env): boolean {
  return !!(env.ANALYTICS && env.CF_ACCOUNT_ID?.trim() && env.CF_API_TOKEN?.trim());
}

export function resolveDataset(env: Env): string {
  const name = env.ANALYTICS_DATASET?.trim() || DEFAULT_DATASET;
  if (!DATASET_RE.test(name)) {
    throw new HttpError(500, 'invalid_analytics_config', 'ANALYTICS_DATASET must be 1–64 ASCII letters, digits, or underscores');
  }
  return name;
}

export function parseAnalyticsParams(url: URL): { range: AnalyticsRange; tz: number; includeBots: boolean } {
  const rawRange = url.searchParams.get('range') ?? '7d';
  if (!Object.hasOwn(RANGE_CONFIG, rawRange)) {
    throw new HttpError(400, 'invalid_range', 'range must be one of 24h, 7d, 30d, 90d');
  }
  const rawTz = url.searchParams.get('tz');
  let tz = 0;
  if (rawTz !== null && rawTz !== '') {
    if (!/^-?\d{1,4}$/.test(rawTz)) {
      throw new HttpError(400, 'invalid_tz', 'tz must be an integer between -720 and 840');
    }
    tz = Number(rawTz);
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) {
      throw new HttpError(400, 'invalid_tz', 'tz must be an integer between -720 and 840');
    }
  }
  const rawBots = url.searchParams.get('bots') ?? '0';
  if (rawBots !== '0' && rawBots !== '1') {
    throw new HttpError(400, 'invalid_bots', 'bots must be 0 or 1');
  }
  return { range: rawRange as AnalyticsRange, tz, includeBots: rawBots === '1' };
}

function truncateUtf8(str: string, maxBytes: number): string {
  if (!str) return '';
  let out = '';
  let used = 0;
  for (const ch of str) {
    const len = enc.encode(ch).byteLength;
    if (used + len > maxBytes) break;
    out += ch;
    used += len;
  }
  return out;
}

const BOT_UA_RE = /googlebot|bingbot|bingpreview|slackbot|discordbot|twitterbot|whatsapp|telegrambot|facebookexternalhit|facebot|linkedinbot|applebot|duckduckbot|baiduspider|bytespider|claudebot|gptbot|oai-searchbot|chatgpt-user|anthropic-ai|perplexitybot|yandexbot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|sogou|headlesschrome|lighthouse|phantomjs|uptimerobot|pingdom|crawler|spider|slurp|mediapartners-google|adsbot-google|\bbots?\b/i;
const CLI_UA_RE = /^(curl|wget|httpie|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|undici|node-fetch|axios|got|okhttp|java|libwww-perl|ruby|php|deno|bun)\b|\b(curl|wget|httpie|python-requests|python-httpx|go-http-client|undici|node-fetch|axios)\b/i;
const TABLET_UA_RE = /ipad|tablet|kindle|silk|playbook|nexus (?:7|9|10)|sm-t\d/i;
const MOBILE_UA_RE = /mobile|iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|iemobile/i;

export function classifyDevice(ua: string | null): AnalyticsDevice {
  const s = (ua ?? '').trim();
  if (!s) return 'cli';
  if (BOT_UA_RE.test(s)) return 'bot';
  if (CLI_UA_RE.test(s)) return 'cli';
  if (TABLET_UA_RE.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) return 'tablet';
  if (MOBILE_UA_RE.test(s)) return 'mobile';
  return 'desktop';
}

export function isVerifiedBot(req: Request): boolean {
  const cf = (req as Request & { cf?: { botManagement?: { verifiedBot?: unknown } } }).cf;
  return cf?.botManagement?.verifiedBot === true;
}

export function isPrefetchRequest(req: Request): boolean {
  const p = `${req.headers.get('sec-purpose') ?? ''} ${req.headers.get('purpose') ?? ''}`;
  return /\b(prefetch|prerender)\b/i.test(p);
}

export function classifyRequestDevice(req: Request): AnalyticsDevice {
  if (isVerifiedBot(req)) return 'bot';
  return classifyDevice(req.headers.get('user-agent'));
}

/** Whether a page load should increment D1 `view_count` (excludes bots, CLIs, and browser prefetches). */
export function shouldCountView(req: Request): boolean {
  if (isPrefetchRequest(req)) return false;
  const device = classifyRequestDevice(req);
  return device !== 'bot' && device !== 'cli';
}

function coarseUaGroup(ua: string | null, device: AnalyticsDevice): string {
  if (device === 'bot' || device === 'cli') return device;
  const s = ua ?? '';
  const os = /iphone|ipad|ipod/i.test(s)
    ? 'ios'
    : /android/i.test(s)
      ? 'android'
      : /mac os x|macintosh/i.test(s)
        ? 'mac'
        : /windows/i.test(s)
          ? 'win'
          : /linux/i.test(s)
            ? 'linux'
            : 'other';
  const browser = /edg\//i.test(s)
    ? 'edge'
    : /firefox\//i.test(s)
      ? 'ff'
      : /chrome\/|crios\//i.test(s)
        ? 'chrome'
        : /safari\//i.test(s)
          ? 'safari'
          : 'other';
  return `${device}:${os}:${browser}`;
}

async function computeVisitorId(secret: string, ip: string, uaGroup: string): Promise<string> {
  const ym = new Date().toISOString().slice(0, 7);
  const { sign } = await getKeys(secret);
  const mac = await crypto.subtle.sign('HMAC', sign, enc.encode(`uv:${ym}:${ip}:${uaGroup}`));
  const bytes = new Uint8Array(mac, 0, 8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function extractCountry(req: Request): string {
  const raw = (req as Request & { cf?: { country?: unknown } }).cf?.country;
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return '';
  return code;
}

export function classifyReferer(referer: string | null, env: Env): string {
  if (!referer) return '';
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  const mainHost = env.MAIN_HOST.toLowerCase();
  const contentZone = env.CONTENT_ZONE.toLowerCase();
  const isInternal = (h: string) => h === mainHost || h === contentZone || h.endsWith(`.${contentZone}`);
  if (isInternal(host)) return INTERNAL_REFERER;
  if (host.startsWith('www.') && host.slice(4).includes('.')) {
    host = host.slice(4);
    if (isInternal(host)) return INTERNAL_REFERER;
  }
  return truncateUtf8(host, 128);
}

export function normalizeRefererHost(referer: string | null, env: Env): string {
  const c = classifyReferer(referer, env);
  return c === INTERNAL_REFERER ? '' : c;
}

function scheduleWrite(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  req: Request,
  a: ArtifactRow,
  event: AnalyticsEvent,
  path: string,
  bytes: number,
  precomputedReferer?: string,
): void {
  try {
    if (!analyticsEnabled(env)) return;
    const dataset = env.ANALYTICS!;
    const ip = clientIp(req);
    const ua = req.headers.get('user-agent');
    const device = classifyRequestDevice(req);
    const uaGroup = coarseUaGroup(ua, device);
    const country = extractCountry(req);
    const refererHost = precomputedReferer ?? classifyReferer(req.headers.get('referer'), env);
    const cleanPath = truncateUtf8(path, 256);
    const version = typeof a.current_version === 'number' && Number.isFinite(a.current_version) && a.current_version >= 0 ? a.current_version : 0;
    const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;

    ctx.waitUntil(
      (async () => {
        const visitorId = await computeVisitorId(env.SECRET_KEY, ip, uaGroup);
        dataset.writeDataPoint({
          indexes: [a.id],
          blobs: [event, visitorId, country, refererHost, device, cleanPath, a.visibility],
          doubles: [version, safeBytes],
        });
      })().catch(() => {}),
    );
  } catch {
    // Analytics must never break content serving or downloads.
  }
}

export function recordView(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, req: Request, a: ArtifactRow, servedPath: string, bytes: number): void {
  try {
    if (isPrefetchRequest(req)) return;
    let refererHost = classifyReferer(req.headers.get('referer'), env);
    if (req.headers.get('sec-fetch-dest') === 'iframe' && refererHost === '') {
      refererHost = INTERNAL_REFERER;
    }
    scheduleWrite(env, ctx, req, a, 'view', servedPath, bytes, refererHost);
  } catch {
    // Analytics must never break content serving.
  }
}

export function recordDownload(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, req: Request, a: ArtifactRow, kind: 'source' | 'zip', bytes: number): void {
  scheduleWrite(env, ctx, req, a, 'download', kind, bytes);
}

export function recordReferral(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, req: Request, a: ArtifactRow): void {
  try {
    if (!analyticsEnabled(env) || isPrefetchRequest(req)) return;
    const refererHost = classifyReferer(req.headers.get('referer'), env);
    if (refererHost === INTERNAL_REFERER) return;
    scheduleWrite(env, ctx, req, a, 'referral', '', 0, refererHost);
  } catch {
    // Analytics must never break viewer responses.
  }
}

// ---------------- SQL API Query Engine ----------------

interface SqlApiResult<T> {
  data: T[];
  missingDataset: boolean;
}

const MISSING_DATASET_RE = /does not exist|doesn't exist|unknown table|no such table|table .* not found|dataset .* not found/i;

async function runSql<T>(env: Env, sql: string, dataset: string): Promise<SqlApiResult<T>> {
  const accountId = env.CF_ACCOUNT_ID!.trim();
  const token = env.CF_API_TOKEN!.trim();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain; charset=utf-8',
      },
      body: sql,
    });
  } catch {
    throw new HttpError(502, 'analytics_upstream_error', 'Analytics upstream request failed');
  }

  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 400 || res.status === 404) && text.includes(dataset) && MISSING_DATASET_RE.test(text)) {
      return { data: [], missingDataset: true };
    }
    throw new HttpError(502, 'analytics_upstream_error', `Analytics upstream returned ${res.status}`);
  }

  let parsed: { data?: T[] };
  try {
    parsed = JSON.parse(text) as { data?: T[] };
  } catch {
    throw new HttpError(502, 'analytics_upstream_error', 'Invalid analytics upstream response');
  }
  return { data: Array.isArray(parsed.data) ? parsed.data : [], missingDataset: false };
}

const toInt = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

function buildSeries(
  rows: Array<{ bucket_ts: number | string; event: string; total: number | string; uv: number | string }>,
  stepSec: number,
  bucketCount: number,
  currentBucket: number,
): AnalyticsSeriesPoint[] {
  const byTs = new Map<number, AnalyticsSeriesPoint>();
  const series: AnalyticsSeriesPoint[] = [];

  for (let i = bucketCount - 1; i >= 0; i--) {
    const ts = currentBucket - i * stepSec;
    const point: AnalyticsSeriesPoint = { ts, views: 0, visitors: 0, downloads: 0 };
    byTs.set(ts, point);
    series.push(point);
  }

  for (const row of rows) {
    const ts = Number(row.bucket_ts);
    const target = byTs.get(ts);
    if (!target) continue;
    if (row.event === 'view') {
      target.views += toInt(row.total);
      target.visitors += toInt(row.uv);
    } else if (row.event === 'download') {
      target.downloads += toInt(row.total);
    }
  }
  return series;
}

const VALID_DEVICES = new Set<AnalyticsDevice>(['desktop', 'mobile', 'tablet', 'bot', 'cli']);

export async function queryAnalytics(
  env: Env,
  opts: { artifact?: ArtifactRow; range: AnalyticsRange; tz: number; includeBots: boolean },
): Promise<AnalyticsResponse> {
  if (!analyticsEnabled(env)) return { enabled: false };

  const accountId = env.CF_ACCOUNT_ID!.trim();
  const dataset = resolveDataset(env);
  const cfg = RANGE_CONFIG[opts.range];
  const cacheKey = `${accountId}:${dataset}:${opts.artifact?.id ?? 'site'}:${opts.artifact?.kind ?? 'site'}:${opts.range}:${opts.tz}:${opts.includeBots ? 1 : 0}`;
  const nowMs = Date.now();
  const cached = queryCache.get(cacheKey);
  if (cached && cached.exp > nowMs) return cached.data;
  if (cached) queryCache.delete(cacheKey);

  if (opts.artifact && !isUuid(opts.artifact.id)) {
    throw new HttpError(400, 'invalid_artifact_id', 'Invalid artifact ID');
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const task = (async (): Promise<Exclude<AnalyticsResponse, { enabled: false }>> => {
    const scopeFilter = opts.artifact ? `index1 = '${opts.artifact.id}' AND ` : '';
    const shift = 86400 + opts.tz * 60;
    const nowSec = Math.floor(nowMs / 1000);
    const currentBucket = Math.floor((nowSec + shift) / cfg.stepSec) * cfg.stepSec - shift;
    const startTs = currentBucket - (cfg.buckets - 1) * cfg.stepSec;
    const timeFilter = `timestamp >= toDateTime(${startTs})`;
    const botFilter = opts.includeBots ? '' : " AND blob5 NOT IN ('bot', 'cli')";

    const totalsSql = `SELECT blob1 AS event, SUM(_sample_interval) AS total, COUNT(DISTINCT blob2) AS uv, SUM(if(blob4 = '', _sample_interval, 0)) AS no_ref FROM ${dataset} WHERE ${scopeFilter}blob1 IN ('view', 'download', 'referral') AND ${timeFilter}${botFilter} GROUP BY event FORMAT JSON`;
    const seriesSql = `SELECT intDiv(toUInt32(timestamp) + ${shift}, ${cfg.stepSec}) * ${cfg.stepSec} - ${shift} AS bucket_ts, blob1 AS event, SUM(_sample_interval) AS total, COUNT(DISTINCT blob2) AS uv FROM ${dataset} WHERE ${scopeFilter}blob1 IN ('view', 'download') AND ${timeFilter}${botFilter} GROUP BY bucket_ts, event ORDER BY bucket_ts ASC FORMAT JSON`;
    const countriesSql = `SELECT blob3 AS code, SUM(_sample_interval) AS views FROM ${dataset} WHERE ${scopeFilter}blob1 = 'view' AND blob3 != '' AND ${timeFilter}${botFilter} GROUP BY code ORDER BY views DESC LIMIT 8 FORMAT JSON`;
    const referrersSql = `SELECT blob4 AS host, SUM(_sample_interval) AS hits FROM ${dataset} WHERE ${scopeFilter}blob1 IN ('referral', 'view') AND blob4 != '' AND blob4 != '${INTERNAL_REFERER}' AND ${timeFilter}${botFilter} GROUP BY host ORDER BY hits DESC LIMIT 8 FORMAT JSON`;
    const devicesSql = `SELECT blob5 AS device, SUM(_sample_interval) AS views FROM ${dataset} WHERE ${scopeFilter}blob1 = 'view' AND blob5 != '' AND ${timeFilter}${botFilter} GROUP BY device ORDER BY views DESC FORMAT JSON`;

    const needPaths = opts.artifact?.kind === 'folder';
    const needTopArtifacts = !opts.artifact;

    const extraSql = needPaths
      ? `SELECT blob6 AS path, SUM(_sample_interval) AS views FROM ${dataset} WHERE ${scopeFilter}blob1 = 'view' AND blob6 != '' AND ${timeFilter}${botFilter} GROUP BY path ORDER BY views DESC LIMIT 8 FORMAT JSON`
      : needTopArtifacts
        ? `SELECT index1 AS id, SUM(_sample_interval) AS views, COUNT(DISTINCT blob2) AS visitors FROM ${dataset} WHERE blob1 = 'view' AND index1 != '' AND ${timeFilter}${botFilter} GROUP BY id ORDER BY views DESC LIMIT 10 FORMAT JSON`
        : null;
    const since90d = nowSec - VIEWS_WINDOW_DAYS * 86400;
    // Always query rolling 90d so `views_90d` stays timezone-independent and matches `/api/v1/analytics/views`.
    const views90dSql = `SELECT SUM(_sample_interval) AS total FROM ${dataset} WHERE ${scopeFilter}blob1 = 'view' AND timestamp >= toDateTime(${since90d})${botFilter} FORMAT JSON`;

    const [totalsRes, seriesRes, countriesRes, referrersRes, devicesRes, extraRes, views90dRes] = await Promise.all([
      runSql<{ event: string; total: number | string; uv: number | string; no_ref?: number | string }>(env, totalsSql, dataset),
      runSql<{ bucket_ts: number | string; event: string; total: number | string; uv: number | string }>(env, seriesSql, dataset),
      runSql<{ code: string; views: number | string }>(env, countriesSql, dataset),
      runSql<{ host: string; hits: number | string }>(env, referrersSql, dataset),
      runSql<{ device: string; views: number | string }>(env, devicesSql, dataset),
      extraSql ? runSql<Record<string, unknown>>(env, extraSql, dataset) : Promise.resolve(null),
      runSql<{ total: number | string }>(env, views90dSql, dataset),
    ]);

    const datasetMissing = [totalsRes, seriesRes, countriesRes, referrersRes, devicesRes, extraRes, views90dRes].some((r) => r?.missingDataset);

    let views = 0;
    let visitors = 0;
    let downloads = 0;
    let noRefViews = 0;
    let noRefReferrals = 0;
    for (const r of totalsRes.data) {
      if (r.event === 'view') {
        views = toInt(r.total);
        visitors = toInt(r.uv);
        noRefViews = toInt(r.no_ref);
      } else if (r.event === 'download') {
        downloads = toInt(r.total);
      } else if (r.event === 'referral') {
        noRefReferrals = toInt(r.no_ref);
      }
    }
    const views90d = toInt(views90dRes.data[0]?.total);

    const series = buildSeries(seriesRes.data, cfg.stepSec, cfg.buckets, currentBucket);

    const countries = countriesRes.data
      .map((r) => ({ code: String(r.code ?? '').trim(), views: toInt(r.views) }))
      .filter((r) => r.code && r.views > 0);

    const externalRefs = referrersRes.data
      .map((r) => ({ host: String(r.host ?? '').trim(), count: toInt(r.hits) }))
      .filter((r) => r.host && r.count > 0);
    const directCount = noRefViews + noRefReferrals;
    const referrers = [...externalRefs];
    if (directCount > 0) referrers.push({ host: 'direct', count: directCount });
    referrers.sort((a, b) => b.count - a.count);
    referrers.splice(8);

    const devices = devicesRes.data
      .map((r) => ({ type: String(r.device ?? '').trim() as AnalyticsDevice, views: toInt(r.views) }))
      .filter((r) => VALID_DEVICES.has(r.type) && r.views > 0);

    const result: Exclude<AnalyticsResponse, { enabled: false }> = {
      enabled: true,
      ...(datasetMissing ? { dataset_missing: true } : {}),
      range: opts.range,
      bucket: cfg.bucket,
      totals: {
        views,
        visitors,
        downloads,
        views_90d: views90d,
      },
      series,
      countries,
      referrers,
      devices,
    };

    if (needPaths && extraRes) {
      result.paths = extraRes.data
        .map((r) => ({ path: String(r.path ?? ''), views: toInt(r.views) }))
        .filter((r) => r.path && r.views > 0);
    }

    if (needTopArtifacts && extraRes) {
      const rawTop = extraRes.data
        .map((r) => ({ id: String(r.id ?? '').trim(), views: toInt(r.views), visitors: toInt(r.visitors) }))
        .filter((r) => r.id && r.views > 0);
      const validIds = [...new Set(rawTop.map((r) => r.id).filter(isUuid))];
      const byId = new Map<string, { title: string; kind: ArtifactRow['kind']; visibility: Visibility; deleted_at: number | null }>();
      if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(', ');
        const { results } = await env.DB.prepare(
          `SELECT id, title, kind, visibility, deleted_at FROM artifacts WHERE id IN (${placeholders})`,
        )
          .bind(...validIds)
          .all<{ id: string; title: string; kind: ArtifactRow['kind']; visibility: Visibility; deleted_at: number | null }>();
        for (const row of results) byId.set(row.id, row);
      }
      result.top_artifacts = rawTop.map((r) => {
        const meta = byId.get(r.id);
        return {
          id: r.id,
          title: meta?.title ?? '',
          kind: meta?.kind ?? null,
          visibility: meta?.visibility ?? null,
          deleted: !meta || meta.deleted_at !== null,
          views: r.views,
          visitors: r.visitors,
        };
      });
    }

    if (!datasetMissing) {
      if (queryCache.size >= CACHE_MAX) {
        const oldest = queryCache.keys().next().value;
        if (oldest !== undefined) queryCache.delete(oldest);
      }
      queryCache.set(cacheKey, { exp: Date.now() + CACHE_TTL_MS, data: result });
    }
    return result;
  })().finally(() => {
    if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, task);
  return task;
}

export function parseViewsIds(url: URL): string[] {
  const raw = url.searchParams.get('ids') ?? '';
  if (!raw.trim()) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!isUuid(id)) throw new HttpError(400, 'invalid_ids', 'Invalid artifact ID');
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > MAX_VIEWS_IDS) {
      throw new HttpError(400, 'invalid_ids', `At most ${MAX_VIEWS_IDS} artifact IDs per request`);
    }
  }
  return ids;
}

/** Batch 90-day view counts (excluding bots/CLIs) from Analytics Engine for artifact list & detail views. */
export async function queryAnalyticsViews(env: Env, ids: string[]): Promise<AnalyticsViewsResponse> {
  if (!analyticsEnabled(env)) return { enabled: false };
  const cleanIds = [...new Set(ids)];
  if (!cleanIds.length) return { enabled: true, window_days: VIEWS_WINDOW_DAYS, views: {} };
  if (cleanIds.length > MAX_VIEWS_IDS || cleanIds.some((id) => !isUuid(id))) {
    throw new HttpError(400, 'invalid_ids', 'Invalid artifact ID');
  }

  const accountId = env.CF_ACCOUNT_ID!.trim();
  const dataset = resolveDataset(env);
  const sortedIds = [...cleanIds].sort();
  const cacheKey = `${accountId}:${dataset}:${sortedIds.join(',')}`;
  const nowMs = Date.now();
  const cached = viewsCache.get(cacheKey);
  if (cached && cached.exp > nowMs) return cached.data;
  if (cached) viewsCache.delete(cacheKey);

  const pending = viewsInFlight.get(cacheKey);
  if (pending) return pending;

  const task = (async (): Promise<Exclude<AnalyticsViewsResponse, { enabled: false }>> => {
    const sinceSec = Math.floor(nowMs / 1000) - VIEWS_WINDOW_DAYS * 86400;
    const idList = sortedIds.map((id) => `'${id}'`).join(', ');
    const sql = `SELECT index1 AS id, SUM(_sample_interval) AS views FROM ${dataset} WHERE blob1 = 'view' AND index1 IN (${idList}) AND timestamp >= toDateTime(${sinceSec}) AND blob5 NOT IN ('bot', 'cli') GROUP BY id FORMAT JSON`;
    const res = await runSql<{ id: string; views: number | string }>(env, sql, dataset);
    const views: Record<string, number> = {};
    for (const id of sortedIds) views[id] = 0;
    for (const row of res.data) {
      const id = String(row.id ?? '').trim();
      if (Object.hasOwn(views, id)) views[id] = toInt(row.views);
    }
    const result: Exclude<AnalyticsViewsResponse, { enabled: false }> = {
      enabled: true,
      ...(res.missingDataset ? { dataset_missing: true } : {}),
      window_days: VIEWS_WINDOW_DAYS,
      views,
    };
    if (!res.missingDataset) {
      if (viewsCache.size >= CACHE_MAX) {
        const oldest = viewsCache.keys().next().value;
        if (oldest !== undefined) viewsCache.delete(oldest);
      }
      viewsCache.set(cacheKey, { exp: Date.now() + CACHE_TTL_MS, data: result });
    }
    return result;
  })().finally(() => {
    if (viewsInFlight.get(cacheKey) === task) viewsInFlight.delete(cacheKey);
  });

  viewsInFlight.set(cacheKey, task);
  return task;
}
