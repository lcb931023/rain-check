import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { wgs84ToGcj02 } from './gcj02.js';
import { FLOOD_BANDS } from './render.js';
import {
  contourFeatures, drawElevationCanvas, elevationScale, supersample, type ElevationScale,
} from './elevation.js';
import { t } from './strings.js';
import type { ElevationGrid, Report } from '../../shared/types.js';

const AMAP_TILES = [1, 2, 3, 4].map(
  (i) => `https://webrd0${i}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`,
);

type Quad = [[number, number], [number, number], [number, number], [number, number]];

/**
 * A canvas source with animate:false only re-uploads its texture when prepare() sees
 * resize || _playing, so triggerRepaint() alone would re-render the stale texture — and a
 * layer that starts hidden never gets that first upload at all, so revealing it later
 * would show nothing. play()+pause() runs prepare() once, synchronously, with _playing set.
 */
function nudgeCanvasSource(map: maplibregl.Map, id: string): void {
  const source = map.getSource(id) as maplibregl.CanvasSource | undefined;
  if (source) { source.play(); source.pause(); }
}

/** A world-sized rectangle with the covered area punched out of it, for the outside scrim. */
function coverageMask(quad: Quad): GeoJSON.Feature<GeoJSON.Polygon> {
  const world: [number, number][] = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return {
    type: 'Feature',
    properties: {},
    // Second ring is a hole: opposite winding to the first, per the GeoJSON spec.
    geometry: { type: 'Polygon', coordinates: [world, [...quad, quad[0]]] },
  };
}

export function initMap(container: HTMLElement, elev: ElevationGrid, center: [number, number]) {
  const map = new maplibregl.Map({
    container,
    center: wgs84ToGcj02(center[0], center[1]),
    zoom: 10,
    style: {
      version: 8,
      // AMap serves this style up to z18; without maxzoom MapLibre requests z19+ tiles,
      // gets nothing back and the basemap goes blank. With it, z18 tiles are overscaled.
      sources: { base: { type: 'raster', tiles: AMAP_TILES, tileSize: 256, maxzoom: 18, attribution: '© 高德地图' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    },
  });

  const canvas = document.createElement('canvas');
  canvas.width = elev.lons.length;
  canvas.height = elev.lats.length;

  // The terrain tint shares the flood layer's geometry, so it gets its own canvas of the
  // same size rather than sharing one: both are on screen at once when the toggle is on.
  const elevCanvas = document.createElement('canvas');
  elevCanvas.width = elev.lons.length;
  elevCanvas.height = elev.lats.length;
  // The tint keeps the base scale whatever the contour detail is: its colours are the
  // percentile ramp, which the detail handle does not touch, and redrawing it on every
  // slider step would re-upload a texture for no visible change.
  const scale = elevationScale(elev.elevation);
  drawElevationCanvas(elevCanvas.getContext('2d')!, elev.elevation, elevCanvas.width, elevCanvas.height, scale);

  let contourScale = scale;
  const buildContours = (detail: number) => {
    contourScale = elevationScale(elev.elevation, detail);
    const source = supersample(elev, detail);
    return contourFeatures(source, contourScale, wgs84ToGcj02);
  };

  const dLon = elev.lons[1] - elev.lons[0];
  const dLat = elev.lats[1] - elev.lats[0];
  const w = elev.lons[0] - dLon / 2, e = elev.lons[elev.lons.length - 1] + dLon / 2;
  const s = elev.lats[0] - dLat / 2, n = elev.lats[elev.lats.length - 1] + dLat / 2;
  // Canvas sources want exactly four corners, clockwise from the top left.
  const quad: [[number, number], [number, number], [number, number], [number, number]] =
    [wgs84ToGcj02(w, n), wgs84ToGcj02(e, n), wgs84ToGcj02(e, s), wgs84ToGcj02(w, s)];

  map.on('load', () => {
    // Added before the flood layer so terrain reads as context underneath the data.
    map.addSource('elevation', { type: 'canvas', canvas: elevCanvas, animate: false, coordinates: quad });
    map.addLayer({
      id: 'elevation',
      type: 'raster',
      source: 'elevation',
      layout: { visibility: 'none' },
      paint: { 'raster-resampling': 'linear', 'raster-opacity': 1 },
    });

    map.addSource('contours', { type: 'geojson', data: buildContours(1) });
    map.addLayer({
      id: 'contours',
      type: 'line',
      source: 'contours',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(60, 40, 20, 0.75)',
        // Every 5th contour is heavier so they can be counted against the legend's interval.
        'line-width': ['case', ['get', 'major'], 1.6, 0.7],
      },
    });

    map.addSource('flood', { type: 'canvas', canvas, animate: false, coordinates: quad });
    map.addLayer({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-resampling': 'linear' } });

    // Ground outside the elevation grid is dimmed rather than left plain. The model has no
    // terrain there, so an undimmed basemap would read as "no flooding here" when it means
    // "not modelled here" — the same ambiguity the coverage counter exists to resolve.
    map.addSource('coverage', { type: 'geojson', data: coverageMask(quad) });
    map.addLayer({
      id: 'coverage-scrim',
      type: 'fill',
      source: 'coverage',
      paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.16 },
    });

    map.addSource('coverage-edge', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [...quad, quad[0]] },
      },
    });
    // A soft light halo under a fine dashed line, so the edge stays legible over both the
    // pale streets inside and the dimmed ground outside without looking like a road.
    map.addLayer({
      id: 'coverage-edge-halo',
      type: 'line',
      source: 'coverage-edge',
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-blur': 2, 'line-opacity': 0.6 },
    });
    map.addLayer({
      id: 'coverage-edge',
      type: 'line',
      source: 'coverage-edge',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#1e293b',
        'line-width': 1.4,
        'line-opacity': 0.8,
        'line-dasharray': [4, 3],
      },
    });
  });

  const setElevationVisible = (on: boolean) => {
    const apply = () => {
      for (const id of ['elevation', 'contours']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
      // The tint layer starts hidden, so its canvas texture was never uploaded; without
      // this the first time it is switched on it draws nothing until some other event
      // happens to force a redraw.
      if (on) { nudgeCanvasSource(map, 'elevation'); map.triggerRepaint(); }
    };
    // Gate on the layers themselves, not on isStyleLoaded(): that returns false whenever
    // any source is still fetching, which for a raster basemap is most of the time. Using
    // it here deferred a mid-session toggle to a 'load' event that had already fired, so
    // the click did nothing at all. The layers existing is the real precondition.
    if (map.getLayer('elevation')) apply();
    else map.once('load', apply);
  };

  /** Recomputes the contour set and returns the scale actually used, for the legend. */
  const setContourDetail = (detail: number): ElevationScale => {
    const data = buildContours(detail);
    const source = map.getSource('contours') as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
    return contourScale;
  };

  return {
    map,
    canvas,
    elevationScale: scale,
    setElevationVisible,
    setContourDetail,
    repaint: () => {
      nudgeCanvasSource(map, 'flood');
      map.triggerRepaint();
    },
  };
}

/** Only absolute http(s) links become anchors; `javascript:` and friends fall back to plain text. */
function httpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function addReports(map: maplibregl.Map, reports: Report[]) {
  for (const rep of reports) {
    const [lng, lat] = wgs84ToGcj02(rep.lon, rep.lat);
    // Built as DOM rather than an HTML string: report fields are curated today, but the
    // moment they come from anywhere else interpolating them would be script injection.
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = rep.title;
    body.append(title, document.createElement('br'));

    const href = httpUrl(rep.url);
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = rep.source;
      body.append(a);
    } else {
      body.append(rep.source);
    }
    body.append(` · ${new Date(rep.time).toLocaleString()}`);

    new maplibregl.Marker({ color: ['#7EB8FF', '#2E6BE6', '#0B2E8A'][rep.severity - 1] })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup().setDOMContent(body))
      .addTo(map);
  }
}

/**
 * Opens the cell's 72-hour curve and returns a redraw hook: the curve is a view of a series
 * the drainage slider recomputes, so the caller feeds it the new series rather than the popup
 * holding a copy that silently goes stale. A no-op once the popup has been closed.
 */
export function showCellPopup(
  map: maplibregl.Map,
  gcjLngLat: { lng: number; lat: number },
  series: Float32Array[],
  hours: string[],
  nowIndex: number,
  displayIndex: number,
  cellIdx: number,
): (series: Float32Array[], displayIndex: number) => void {
  const cv = document.createElement('canvas');
  cv.width = 240; cv.height = 80;
  const ctx = cv.getContext('2d')!;
  const caption = Object.assign(document.createElement('div'), { style: 'font-weight:600' });
  const wrap = document.createElement('div');
  wrap.append(caption, cv);

  const render = (s: Float32Array[], ti: number) => {
    const values = s.map((f) => f[cellIdx]);
    const max = Math.max(FLOOD_BANDS.severe, ...values);
    const px = (i: number) => (i / (values.length - 1)) * 240;
    const py = (v: number) => 78 - (v / max) * 70;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setLineDash([]);
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
    ctx.arc(Math.min(237, Math.max(3, px(ti))), py(values[ti]), 3, 0, 2 * Math.PI);
    ctx.fill();

    const v = values[ti];
    const band = v >= FLOOD_BANDS.severe ? t('bandSevere') : v >= FLOOD_BANDS.possible ? t('bandPossible') : t('bandNone');
    const d = new Date(hours[ti]);
    caption.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00 · ${band}`;
  };

  render(series, displayIndex);
  // maplibre's default popup maxWidth is 240px, which is the canvas width alone: without this
  // the last hours of the sparkline spill outside the popup's white box onto the map.
  const popup = new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(gcjLngLat).setDOMContent(wrap).addTo(map);
  return (s, ti) => { if (popup.isOpen()) render(s, ti); };
}
