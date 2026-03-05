import { randomUUID } from 'crypto';

type ToolWarning = { code: string; message: string };

type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_SELECTION'
  | 'MODE_CONFLICT'
  | 'UNSUPPORTED_OPERATION'
  | 'SOLVER_FAILED'
  | 'CONSTRAINT_VIOLATION'
  | 'PREVIEW_NOT_FOUND'
  | 'HISTORY_EMPTY'
  | 'SCENE_OUT_OF_SYNC'
  | 'INTERNAL_ERROR';

type ToolEnvelope<T> =
  | {
      ok: true;
      sceneRevision: number;
      data: T;
      warnings: ToolWarning[];
      debug?: unknown;
    }
  | {
      ok: false;
      sceneRevision?: number;
      error: {
        code: ToolErrorCode;
        message: string;
        recoverable: boolean;
        detail?: unknown;
        suggestedToolCalls: Array<{ tool: string; args: Record<string, unknown>; reason?: string }>;
      };
      warnings: ToolWarning[];
    };

const DEFAULT_TIMEOUT_MS = Number(process.env.ROUTER_WEB_TIMEOUT_MS || 2600);
const CACHE_TTL_MS = Math.max(0, Number(process.env.ROUTER_WEB_CACHE_TTL_MS || 60_000));
const WEB_ENABLED = process.env.ROUTER_WEB_ENABLE === '1';

const cache = new Map<string, { expiresAt: number; value: unknown }>();

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

function ok<T>(data: T, options?: { warnings?: ToolWarning[]; debug?: unknown }): ToolEnvelope<T> {
  return {
    ok: true,
    sceneRevision: 0,
    data,
    warnings: options?.warnings ?? [],
    ...(options?.debug === undefined ? {} : { debug: options.debug }),
  };
}

function fail<T = never>(params: { code: ToolErrorCode; message: string; recoverable?: boolean; detail?: unknown }): ToolEnvelope<T> {
  return {
    ok: false,
    sceneRevision: 0,
    error: {
      code: params.code,
      message: params.message,
      recoverable: params.recoverable ?? true,
      detail: params.detail,
      suggestedToolCalls: [],
    },
    warnings: [],
  };
}

async function fetchJson(url: string, options?: { timeoutMs?: number }): Promise<unknown> {
  const cacheKey = url;
  const now = Date.now();
  if (CACHE_TTL_MS > 0) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
  }

  const { controller, timeout } = withTimeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': `v2-router-web-tools/${process.env.npm_package_version || 'dev'} (${randomUUID().slice(0, 8)})`,
      },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const json = await res.json();
    if (CACHE_TTL_MS > 0) {
      cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value: json });
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function flattenDuckDuckGoTopics(topics: any[], out: Array<{ title: string; url?: string; snippet?: string }>) {
  for (const item of topics || []) {
    if (out.length >= 12) return;
    if (item && typeof item === 'object' && Array.isArray(item.Topics)) {
      flattenDuckDuckGoTopics(item.Topics, out);
      continue;
    }
    const text = typeof item?.Text === 'string' ? item.Text : '';
    const url = typeof item?.FirstURL === 'string' ? item.FirstURL : undefined;
    if (!text) continue;
    const [title, ...rest] = text.split(' - ');
    out.push({
      title: title.trim() || text.trim(),
      url,
      snippet: rest.join(' - ').trim() || undefined,
    });
  }
}

export async function queryWebSearch(args: {
  query: string;
  maxResults?: number;
  provider?: 'duckduckgo';
}): Promise<ToolEnvelope<{
  provider: string;
  query: string;
  heading?: string;
  abstract?: string;
  abstractUrl?: string;
  results: Array<{ title: string; url?: string; snippet?: string }>;
}>> {
  if (!WEB_ENABLED) {
    return fail({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Web tools disabled. Set ROUTER_WEB_ENABLE=1 to enable query.web_search.',
    });
  }

  const query = String(args?.query || '').trim();
  if (!query) return fail({ code: 'INVALID_ARGUMENT', message: 'query is required' });

  const maxResults = Math.max(1, Math.min(12, Number(args?.maxResults || 6)));
  const provider = args?.provider || 'duckduckgo';

  if (provider !== 'duckduckgo') {
    return fail({ code: 'INVALID_ARGUMENT', message: `Unsupported provider: ${String(provider)}` });
  }

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const payload: any = await fetchJson(url);
    const results: Array<{ title: string; url?: string; snippet?: string }> = [];
    flattenDuckDuckGoTopics(payload?.RelatedTopics || [], results);
    const trimmed = results.slice(0, maxResults);
    const heading = typeof payload?.Heading === 'string' ? payload.Heading : undefined;
    const abstract = typeof payload?.AbstractText === 'string' ? payload.AbstractText : undefined;
    const abstractUrl = typeof payload?.AbstractURL === 'string' ? payload.AbstractURL : undefined;
    const warnings: ToolWarning[] = [];
    if (!abstract && trimmed.length === 0) {
      warnings.push({ code: 'NO_RESULTS', message: 'No instant-answer results returned.' });
    }

    return ok(
      {
        provider,
        query,
        heading,
        abstract,
        abstractUrl,
        results: trimmed,
      },
      { warnings }
    );
  } catch (error: any) {
    return fail({
      code: 'INTERNAL_ERROR',
      message: `web_search_failed: ${error?.message || 'unknown'}`,
      detail: { provider: 'duckduckgo' },
    });
  }
}

function weatherCodeSummary(code: number | undefined) {
  if (code == null) return undefined;
  // Open-Meteo WMO code mapping (compact)
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code === 51 || code === 53 || code === 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code === 61 || code === 63 || code === 65) return 'Rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code === 71 || code === 73 || code === 75) return 'Snow';
  if (code === 77) return 'Snow grains';
  if (code === 80 || code === 81 || code === 82) return 'Rain showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return `WMO ${code}`;
}

export async function queryWeather(args: {
  location: string;
  days?: number;
  units?: 'metric' | 'imperial';
  language?: string;
}): Promise<ToolEnvelope<{
  provider: 'open-meteo';
  requestedLocation: string;
  resolvedLocation?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  units: { temperature: string; windSpeed: string; precipitation: string };
  current?: {
    time?: string;
    temperature?: number;
    windSpeed?: number;
    windDirection?: number;
    weatherCode?: number;
    summary?: string;
  };
  today?: {
    date?: string;
    temperatureMax?: number;
    temperatureMin?: number;
    precipitationSum?: number;
  };
}>> {
  if (!WEB_ENABLED) {
    return fail({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Web tools disabled. Set ROUTER_WEB_ENABLE=1 to enable query.weather.',
    });
  }

  const location = String(args?.location || '').trim();
  if (!location) return fail({ code: 'INVALID_ARGUMENT', message: 'location is required' });

  const days = Math.max(1, Math.min(7, Number(args?.days || 1)));
  const units = (args?.units || 'metric') as 'metric' | 'imperial';
  const language = String(args?.language || 'en').trim() || 'en';

  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=${encodeURIComponent(
      language
    )}&format=json`;
    const geo: any = await fetchJson(geoUrl);
    const first = Array.isArray(geo?.results) ? geo.results[0] : null;
    if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
      return fail({
        code: 'NOT_FOUND',
        message: `Location not found: ${location}`,
        detail: { provider: 'open-meteo-geocoding' },
      });
    }

    const latitude = Number(first.latitude);
    const longitude = Number(first.longitude);
    const resolvedLocation = [
      first.name,
      first.admin1,
      first.country,
    ]
      .filter((v: any) => typeof v === 'string' && v.trim())
      .join(', ');

    const temperatureUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
    const windspeedUnit = units === 'imperial' ? 'mph' : 'kmh';
    const precipitationUnit = 'mm';

    const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
    forecastUrl.searchParams.set('latitude', String(latitude));
    forecastUrl.searchParams.set('longitude', String(longitude));
    forecastUrl.searchParams.set('timezone', 'auto');
    forecastUrl.searchParams.set('forecast_days', String(days));
    forecastUrl.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m');
    forecastUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum');
    forecastUrl.searchParams.set('temperature_unit', temperatureUnit);
    forecastUrl.searchParams.set('windspeed_unit', windspeedUnit);
    const forecast: any = await fetchJson(forecastUrl.toString());

    const current = forecast?.current || {};
    const daily = forecast?.daily || {};
    const todayIdx = 0;

    const currentCode = typeof current.weather_code === 'number' ? current.weather_code : undefined;
    const out = {
      provider: 'open-meteo' as const,
      requestedLocation: location,
      resolvedLocation: resolvedLocation || undefined,
      latitude,
      longitude,
      timezone: typeof forecast?.timezone === 'string' ? forecast.timezone : undefined,
      units: {
        temperature: units === 'imperial' ? '°F' : '°C',
        windSpeed: units === 'imperial' ? 'mph' : 'km/h',
        precipitation: precipitationUnit,
      },
      current: {
        time: typeof current.time === 'string' ? current.time : undefined,
        temperature: typeof current.temperature_2m === 'number' ? current.temperature_2m : undefined,
        windSpeed: typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : undefined,
        windDirection: typeof current.wind_direction_10m === 'number' ? current.wind_direction_10m : undefined,
        weatherCode: currentCode,
        summary: weatherCodeSummary(currentCode),
      },
      today: {
        date: Array.isArray(daily.time) ? daily.time[todayIdx] : undefined,
        temperatureMax: Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[todayIdx] : undefined,
        temperatureMin: Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[todayIdx] : undefined,
        precipitationSum: Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum[todayIdx] : undefined,
      },
    };

    return ok(out);
  } catch (error: any) {
    return fail({
      code: 'INTERNAL_ERROR',
      message: `weather_failed: ${error?.message || 'unknown'}`,
      detail: { provider: 'open-meteo' },
    });
  }
}

