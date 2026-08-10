import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { wgs84ToGcj02 } from './gcj02.js';
import type { ElevationGrid } from '../../shared/types.js';

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
