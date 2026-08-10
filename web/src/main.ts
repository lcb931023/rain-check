import './style.css';
import { initMap, addReports, showCellPopup } from './mapview.js';
import { drawFloodCanvas, floodColor, FLOOD_BANDS } from './render.js';
import { fetchElevation, fetchRain, fetchReports } from './api.js';
import { wgs84ToGcj02 } from './gcj02.js';
import { precomputeCellWeights } from './interp.js';
import { computeFloodSeries } from './model.js';
import { t, getLang, setLang } from './strings.js';

function applyStrings() {
  document.querySelectorAll<HTMLElement>('[data-s]').forEach((el) => {
    el.textContent = t(el.dataset.s as Parameters<typeof t>[0]);
  });
  document.title = t('title');
  document.getElementById('lang')!.textContent = t('langToggle');
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
freshness.textContent = t('loading');

const elev = await fetchElevation();
const mapHandle = initMap(document.getElementById('map')!, elev);
const ctx = mapHandle.canvas.getContext('2d')!;
applyStrings();

document.getElementById('lang')!.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyStrings();
});

// Curated reports do not depend on the rain grid, so they are wired above the try block:
// a rain outage must not take the reports layer down with it.
fetchReports().then((reports) => addReports(mapHandle.map, reports)).catch(() => {});

const timeInput = document.getElementById('time') as HTMLInputElement;
const drainInput = document.getElementById('drainage') as HTMLInputElement;
const timeLabel = document.getElementById('timelabel')!;

try {
  const rain = await fetchRain();
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
    // Invert: find nearest elevation cell. GCJ-02 offset in Shanghai is a few hundred
    // meters; for cell lookup (~280 m cells) invert by subtracting the local offset.
    const [glon, glat] = [ev.lngLat.lng, ev.lngLat.lat];
    const [glon2, glat2] = wgs84ToGcj02(glon, glat);
    const wlon = glon - (glon2 - glon); // first-order inverse
    const wlat = glat - (glat2 - glat);
    const xi = Math.round((wlon - elev.lons[0]) / (elev.lons[1] - elev.lons[0]));
    const yi = Math.round((wlat - elev.lats[0]) / (elev.lats[1] - elev.lats[0]));
    if (xi < 0 || xi >= elev.lons.length || yi < 0 || yi >= elev.lats.length) return;
    showCellPopup(mapHandle.map, ev.lngLat, series, rain.hours, rain.nowIndex, yi * elev.lons.length + xi);
  });

  const f = new Date(rain.fetchedAt);
  const now = new Date();
  const sameDay = f.getFullYear() === now.getFullYear()
    && f.getMonth() === now.getMonth()
    && f.getDate() === now.getDate();
  const hm = `${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  freshness.textContent = `${t('updatedAt')} ${sameDay ? hm : `${f.getMonth() + 1}/${f.getDate()} ${hm}`}`;
  draw();
} catch (e) {
  console.error(e);
  freshness.textContent = t('noData');
}
