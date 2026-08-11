import './style.css';
import { initMap, addReports, showCellPopup } from './mapview.js';
import { drawFloodCanvas, floodColor, FLOOD_BANDS } from './render.js';
import { fetchCities, fetchElevation, fetchRain, fetchReports } from './api.js';
import { wgs84ToGcj02 } from './gcj02.js';
import { precomputeCellWeights } from './interp.js';
import { computeFloodSeries } from './model.js';
import { t, getLang, setLang, setCityName } from './strings.js';

const citySelect = document.getElementById('city') as HTMLSelectElement;

function applyStrings() {
  document.querySelectorAll<HTMLElement>('[data-s]').forEach((el) => {
    el.textContent = t(el.dataset.s as Parameters<typeof t>[0]);
  });
  document.title = t('title');
  document.getElementById('lang')!.textContent = t('langToggle');
  // Option labels are city names, which are themselves localized.
  for (const opt of citySelect.options) opt.textContent = cities.find((c) => c.id === opt.value)!.name[getLang()];
  const legend = document.getElementById('legend')!;
  legend.innerHTML = '';
  for (const [label, v] of [
    ['bandNone', 0], ['bandPossible', FLOOD_BANDS.possible], ['bandSevere', FLOOD_BANDS.severe],
  ] as const) {
    const [r, g, b, a] = floodColor(v + 1);
    legend.insertAdjacentHTML(
      'beforeend',
      `<div><i style="background: rgba(${r},${g},${b},${a / 255})"></i>${t(label)}</div>`,
    );
  }
}

const freshness = document.getElementById('freshness')!;
const coverage = document.getElementById('coverage')!;
freshness.textContent = t('loading');

// ?city= wins over the remembered choice so a shared link always opens the city it names.
const cities = await fetchCities();
const requested = new URLSearchParams(location.search).get('city') ?? localStorage.getItem('city');
const city = cities.find((c) => c.id === requested) ?? cities[0];
localStorage.setItem('city', city.id);
setCityName(city.name);

citySelect.append(...cities.map((c) => Object.assign(document.createElement('option'), { value: c.id })));
citySelect.value = city.id;
citySelect.addEventListener('change', () => {
  localStorage.setItem('city', citySelect.value);
  // The elevation grid, rain cache, interpolation weights and map centre are all per-city
  // and all built once at startup, so a reload is both simpler and less bug-prone than
  // tearing that state down in place.
  location.search = `?city=${citySelect.value}`;
});

const elev = await fetchElevation(city.id);
const mapHandle = initMap(document.getElementById('map')!, elev, city.center);
const ctx = mapHandle.canvas.getContext('2d')!;
applyStrings();

document.getElementById('lang')!.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyStrings();
});

// Curated reports do not depend on the rain grid, so they are wired above the try block:
// a rain outage must not take the reports layer down with it.
fetchReports(city.id).then((reports) => addReports(mapHandle.map, reports)).catch(() => {});

const timeInput = document.getElementById('time') as HTMLInputElement;
const drainInput = document.getElementById('drainage') as HTMLInputElement;
const timeLabel = document.getElementById('timelabel')!;

try {
  const rain = await fetchRain(city.id);
  const weights = precomputeCellWeights(rain, elev);
  let series = computeFloodSeries(rain, weights, elev.depression, Number(drainInput.value));

  timeInput.min = '0';
  timeInput.max = String(rain.hours.length - 1);
  timeInput.value = String(rain.nowIndex);

  const draw = () => {
    const ti = Number(timeInput.value);
    drawFloodCanvas(ctx, series[ti], elev.lons.length, elev.lats.length);
    mapHandle.repaint();
    const d = new Date(rain.hours[ti]);
    const rel = ti - rain.nowIndex;
    const relText = rel === 0 ? t('now') : `${rel > 0 ? '+' : ''}${rel}h`;
    const mode = rel < 0 ? t('estimated') : rel > 0 ? t('predicted') : '';
    timeLabel.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00 (${relText}) ${mode}`;
  };

  timeInput.addEventListener('input', draw);
  drainInput.addEventListener('input', () => {
    series = computeFloodSeries(rain, weights, elev.depression, Number(drainInput.value));
    draw();
  });
  timeInput.disabled = false;

  mapHandle.map.on('click', (ev) => {
    // A marker click reaches the map too, so without this a report marker would open its own
    // popup and a cell popup for the ground beneath it, overlapping.
    if ((ev.originalEvent.target as Element | null)?.closest?.('.maplibregl-marker')) return;
    // Invert: find nearest elevation cell. The GCJ-02 offset is a few hundred meters
    // anywhere in China; for cell lookup (~280 m cells) invert by subtracting the local offset.
    const [glon, glat] = [ev.lngLat.lng, ev.lngLat.lat];
    const [glon2, glat2] = wgs84ToGcj02(glon, glat);
    const wlon = glon - (glon2 - glon); // first-order inverse
    const wlat = glat - (glat2 - glat);
    const xi = Math.round((wlon - elev.lons[0]) / (elev.lons[1] - elev.lons[0]));
    const yi = Math.round((wlat - elev.lats[0]) / (elev.lats[1] - elev.lats[0]));
    if (xi < 0 || xi >= elev.lons.length || yi < 0 || yi >= elev.lats.length) return;
    showCellPopup(
      mapHandle.map, ev.lngLat, series, rain.hours,
      rain.nowIndex, Number(timeInput.value), yi * elev.lons.length + xi,
    );
  });

  const f = new Date(rain.fetchedAt);
  const now = new Date();
  const sameDay = f.getFullYear() === now.getFullYear()
    && f.getMonth() === now.getMonth()
    && f.getDate() === now.getDate();
  const hm = `${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  freshness.textContent = `${t('updatedAt')} ${sameDay ? hm : `${f.getMonth() + 1}/${f.getDate()} ${hm}`}`;

  // A grid point that was never fetched and one that reported no rain both draw as dry.
  // The count of non-null points in the current hour is the only client-visible difference,
  // so it is shown whenever the sweep left holes and hidden once the grid is complete.
  const nowSlice = rain.precip[rain.nowIndex];
  const total = nowSlice.reduce((n, row) => n + row.length, 0);
  const covered = nowSlice.reduce((n, row) => n + row.filter((v) => v !== null).length, 0);
  coverage.textContent = `${t('coverage')} ${covered}/${total}`;
  coverage.hidden = covered >= total;

  draw();
} catch (e) {
  console.error(e);
  freshness.textContent = t('noData');
}
