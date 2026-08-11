export interface PointWeather {
  realtimeIntensity: number;
  hourly: { datetime: string; value: number }[];
}

export async function fetchPointWeather(
  lon: number,
  lat: number,
  token: string,
  fetchFn: typeof fetch = fetch,
  begin?: number,
): Promise<PointWeather> {
  // `begin` (unix seconds, up to ~1 day back) shifts the hourly series into the past for
  // history backfill. hourlysteps is capped at 48 by the free plan, so a begin request
  // covers -24h..+24h instead of now..+48h; the sweep decides which window it needs.
  const beginParam = begin === undefined ? '' : `&begin=${begin}`;
  const url = `https://api.caiyunapp.com/v2.6/${token}/${lon},${lat}/weather?hourlysteps=48&unit=metric:v2${beginParam}`;
  // Without a deadline a single hung connection stalls the whole sweep: points are fetched
  // sequentially, so one socket that never answers blocks the remaining grid indefinitely.
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    // The body is the only thing that separates "too fast" from "out of calls" on a 429,
    // and both arrive as the same status. Truncated, and never the URL, which holds the token.
    // Wrapped so that a body that cannot be read still reports the status rather than
    // throwing something unrelated over the top of it.
    const detail = await Promise.resolve()
      .then(() => res.text())
      .then((t) => t.trim().slice(0, 200))
      .catch(() => '');
    throw new Error(`caiyun HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const body: any = await res.json();
  if (body.status !== 'ok') throw new Error(`caiyun API error: ${body.error ?? body.status}`);
  return {
    realtimeIntensity: body.result.realtime.precipitation.local.intensity,
    hourly: body.result.hourly.precipitation.map((p: any) => ({ datetime: p.datetime, value: p.value })),
  };
}
