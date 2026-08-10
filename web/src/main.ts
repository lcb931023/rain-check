import './style.css';
import { initMap } from './mapview.js';
import { drawFloodCanvas, floodColor, FLOOD_BANDS } from './render.js';
import { fetchElevation, fetchRain } from './api.js';
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
const { canvas, repaint } = initMap(document.getElementById('map')!, elev);
const ctx = canvas.getContext('2d')!;
applyStrings();

document.getElementById('lang')!.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyStrings();
});

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
    repaint();
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

  const f = new Date(rain.fetchedAt);
  freshness.textContent = `${t('updatedAt')} ${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  draw();
} catch {
  freshness.textContent = t('noData');
}
