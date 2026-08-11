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
  if (!res.ok) throw new Error(`caiyun HTTP ${res.status}`);
  const body: any = await res.json();
  if (body.status !== 'ok') throw new Error(`caiyun API error: ${body.error ?? body.status}`);
  return {
    realtimeIntensity: body.result.realtime.precipitation.local.intensity,
    hourly: body.result.hourly.precipitation.map((p: any) => ({ datetime: p.datetime, value: p.value })),
  };
}
