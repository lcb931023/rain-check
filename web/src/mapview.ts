import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { wgs84ToGcj02 } from './gcj02.js';
import { FLOOD_BANDS } from './render.js';
import { t } from './strings.js';
import type { ElevationGrid, Report } from '../../shared/types.js';

const AMAP_TILES = [1, 2, 3, 4].map(
  (i) => `https://webrd0${i}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`,
);

export function initMap(container: HTMLElement, elev: ElevationGrid) {
  const map = new maplibregl.Map({
    container,
    center: wgs84ToGcj02(121.47, 31.23),
    zoom: 10,
    style: {
      version: 8,
      sources: { base: { type: 'raster', tiles: AMAP_TILES, tileSize: 256, attribution: '© 高德地图' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    },
  });

  const canvas = document.createElement('canvas');
  canvas.width = elev.lons.length;
  canvas.height = elev.lats.length;

  const dLon = elev.lons[1] - elev.lons[0];
  const dLat = elev.lats[1] - elev.lats[0];
  const w = elev.lons[0] - dLon / 2, e = elev.lons[elev.lons.length - 1] + dLon / 2;
  const s = elev.lats[0] - dLat / 2, n = elev.lats[elev.lats.length - 1] + dLat / 2;

  map.on('load', () => {
    map.addSource('flood', {
      type: 'canvas',
      canvas,
      animate: false,
      coordinates: [wgs84ToGcj02(w, n), wgs84ToGcj02(e, n), wgs84ToGcj02(e, s), wgs84ToGcj02(w, s)],
    });
    map.addLayer({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-resampling': 'linear' } });
  });

  return {
    map,
    canvas,
    // A canvas source with animate:false only re-uploads its texture when prepare() sees
    // resize || _playing, so triggerRepaint() alone would re-render the stale texture.
    // play()+pause() runs prepare() once, synchronously, with _playing set.
    repaint: () => {
      const s = map.getSource('flood') as maplibregl.CanvasSource | undefined;
      if (s) { s.play(); s.pause(); }
      map.triggerRepaint();
    },
  };
}

export function addReports(map: maplibregl.Map, reports: Report[]) {
  for (const rep of reports) {
    const [lng, lat] = wgs84ToGcj02(rep.lon, rep.lat);
    const link = rep.url ? `<a href="${rep.url}" target="_blank" rel="noopener">${rep.source}</a>` : rep.source;
    new maplibregl.Marker({ color: ['#7EB8FF', '#2E6BE6', '#0B2E8A'][rep.severity - 1] })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup().setHTML(
        `<strong>${rep.title}</strong><br>${link} · ${new Date(rep.time).toLocaleString()}`,
      ))
      .addTo(map);
  }
}

export function showCellPopup(
  map: maplibregl.Map,
  gcjLngLat: { lng: number; lat: number },
  series: Float32Array[],
  hours: string[],
  nowIndex: number,
  displayIndex: number,
  cellIdx: number,
) {
  const cv = document.createElement('canvas');
  cv.width = 240; cv.height = 80;
  const ctx = cv.getContext('2d')!;
  const values = series.map((s) => s[cellIdx]);
  const max = Math.max(FLOOD_BANDS.severe, ...values);
  const px = (i: number) => (i / (values.length - 1)) * 240;
  const py = (v: number) => 78 - (v / max) * 70;
  ctx.strokeStyle = '#2E6BE6';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = px(i);
    const y = py(v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  const nx = px(nowIndex);
  ctx.strokeStyle = '#999';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(nx, 0); ctx.lineTo(nx, 80); ctx.stroke();

  // Mark the hour the label describes, so its referent on the curve is visible.
  ctx.fillStyle = '#0B2E8A';
  ctx.beginPath();
  ctx.arc(Math.min(237, Math.max(3, px(displayIndex))), py(values[displayIndex]), 3, 0, 2 * Math.PI);
  ctx.fill();

  const v = values[displayIndex];
  const band = v >= FLOOD_BANDS.severe ? t('bandSevere') : v >= FLOOD_BANDS.possible ? t('bandPossible') : t('bandNone');
  const d = new Date(hours[displayIndex]);
  const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00 · ${band}`;
  const wrap = document.createElement('div');
  wrap.append(Object.assign(document.createElement('div'), { textContent: label, style: 'font-weight:600' }), cv);
  // maplibre's default popup maxWidth is 240px, which is the canvas width alone: without this
  // the last hours of the sparkline spill outside the popup's white box onto the map.
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(gcjLngLat).setDOMContent(wrap).addTo(map);
}
