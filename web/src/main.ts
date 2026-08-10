import './style.css';
import { initMap } from './mapview.js';
import { drawFloodCanvas, floodColor, FLOOD_BANDS } from './render.js';
import { fetchElevation } from './api.js';
import { t, getLang, setLang } from './strings.js';

function applyStrings() {
  document.querySelectorAll<HTMLElement>('[data-s]').forEach((el) => {
    el.textContent = t(el.dataset.s as any);
  });
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

const elev = await fetchElevation();
const { canvas, repaint } = initMap(document.getElementById('map')!, elev);

// Synthetic field: flood proportional to depression factor, to visually verify
// alignment and the transparent-to-blue ramp. Replaced with the real model in the next task.
const synthetic = Float32Array.from(elev.depression, (d) => (d - 0.9) * 60);
drawFloodCanvas(canvas.getContext('2d')!, synthetic, elev.lons.length, elev.lats.length);
repaint();

applyStrings();
document.getElementById('lang')!.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyStrings();
});
