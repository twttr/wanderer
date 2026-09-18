// Our own map tile layer, driven through globe.gl's plain `tilesData`.
//
// globe.gl ships a tile engine of its own and it is deliberately not used: it
// sizes a tile range from the camera altitude while taking the zoom level from
// a separate update, so mid-zoom it computes a near whole-globe range at street
// depth and tries to materialise tens of thousands of tiles in one pass. It
// also accumulates them in a key-value object it never clears. Here we decide
// which tiles exist, cap how many there can ever be, and evict textures on the
// way out, so neither can happen.

export const BASEMAPS = {
  map: { dark: 'dark', light: 'light', maxLevel: 16, credit: 'Esri \u00b7 OpenStreetMap' },
  satellite: { both: 'imagery', maxLevel: 17, credit: 'Esri \u00b7 Maxar \u00b7 Earthstar Geographics' },
  terrain: { both: 'topo', maxLevel: 17, credit: 'Esri \u00b7 OpenStreetMap' },
};

// Shown when zoomed out past the point where map tiles are worth fetching.
export const FAR_IMAGE = {
  dark: 'https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg',
  light: 'https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg',
};

// Tiles and anything drawn onto them must share an altitude. A difference of
// even a hundred metres projects to a visible offset once the view is off
// vertical, which reads as the trace sliding off the roads.
export const SURFACE_ALT = 0.00002;

const TILES_OFF_ABOVE = 0.05;
const TILE_PIXELS = 256;
const MAX_TILES = 120;
const TILE_CACHE_MAX = 240;

const POW = (z) => Math.pow(2, z);
const lng2tile = (lng, z) => ((lng + 180) / 360) * POW(z);
const lat2tile = (lat, z) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * POW(z);
};
const tile2lng = (x, z) => (x / POW(z)) * 360 - 180;
const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / POW(z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * @param globe    the globe.gl instance
 * @param stage    its container, for the viewport size
 * @param service  () => proxy service name for the current basemap/theme
 * @param maxLevel () => deepest zoom that basemap offers
 * @param enabled  whether to draw tiles at all (the ?tiles=off switch)
 */
export function createTileLayer({ globe, stage, service, maxLevel, enabled }) {
  const cache = new Map();
  let MatCtor = null;
  let TexCtor = null;
  let texColorSpace;
  let current = [];
  let shown = 0;

  // The material and texture classes are borrowed from the globe's own image
  // rather than importing three separately: globe.gl bundles its own copy and
  // objects from a second one are not interchangeable.
  function ctorsReady() {
    if (MatCtor && TexCtor) return true;
    const m = globe && globe.globeMaterial && globe.globeMaterial();
    if (!m) return false;
    MatCtor = m.constructor;
    if (m.map) {
      TexCtor = m.map.constructor;
      texColorSpace = m.map.colorSpace;
    }
    return !!(MatCtor && TexCtor);
  }

  function materialFor(z, x, y) {
    const key = `${service()}/${z}/${x}/${y}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const tex = new TexCtor();
    if (texColorSpace !== undefined) tex.colorSpace = texColorSpace;
    const mat = new MatCtor({ map: tex });
    const img = new Image();
    img.onload = () => {
      tex.image = img;
      tex.needsUpdate = true;
      mat.needsUpdate = true;
      mat.userData.ready = true;
    };
    img.src = `/tile?s=${service()}&z=${z}&y=${y}&x=${x}`;
    cache.set(key, mat);
    while (cache.size > TILE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      const dead = cache.get(oldest);
      cache.delete(oldest);
      try { dead.map && dead.map.dispose(); dead.dispose(); } catch {}
    }
    return mat;
  }

  return {
    get shown() { return shown; },
    /** Fraction of the tiles on screen whose image has actually decoded. */
    get ready() {
      return !current.length ? 0 : current.filter((t) => t.material.userData.ready).length / current.length;
    },
    clear() {
      globe.tilesData([]);
      current = [];
      shown = 0;
    },
    /** @returns false if it could not run yet and should be retried */
    update(alt) {
      if (!enabled || alt > TILES_OFF_ABOVE) {
        if (shown) this.clear();
        return true;
      }
      if (!ctorsReady()) return false;

      // Visible ground extent for a 50 degree vertical field of view: the half
      // angle subtended at the globe's centre is about 26.7 degrees per unit of
      // altitude. Tiles are 256 device pixels, not CSS pixels.
      const pov = globe.pointOfView();
      const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
      const halfLat = Math.min(60, alt * 26.7 * 1.15);
      const halfLng = Math.min(60, (halfLat * aspect) / Math.max(0.15, Math.cos((pov.lat * Math.PI) / 180)));
      const across = Math.max(1, (stage.clientWidth * (devicePixelRatio || 1)) / TILE_PIXELS);
      let z = Math.round(Math.log2(360 / ((2 * halfLng) / across)));
      z = Math.max(1, Math.min(maxLevel(), z));

      let box = null;
      for (; z >= 1; z--) {
        const x0 = Math.floor(lng2tile(pov.lng - halfLng, z));
        const x1 = Math.floor(lng2tile(pov.lng + halfLng, z));
        const y0 = Math.floor(lat2tile(pov.lat + halfLat, z));
        const y1 = Math.floor(lat2tile(pov.lat - halfLat, z));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) {
          box = { z, x0, x1, y0, y1 };
          break;
        }
      }
      if (!box) return true;

      const span = POW(box.z);
      const data = [];
      for (let x = box.x0; x <= box.x1; x++) {
        for (let y = box.y0; y <= box.y1; y++) {
          if (y < 0 || y >= span) continue;
          const xi = ((x % span) + span) % span;
          const north = tile2lat(y, box.z);
          const south = tile2lat(y + 1, box.z);
          const west = tile2lng(xi, box.z);
          const east = tile2lng(xi + 1, box.z);
          data.push({
            lat: (north + south) / 2,
            lng: (west + east) / 2,
            width: east - west,
            height: north - south,
            material: materialFor(box.z, xi, y),
          });
        }
      }
      globe.tilesData(data);
      current = data;
      shown = data.length;
      return true;
    },
  };
}
