// Synthetic corridor data: 3 LA -> NYC routes, a deduplicated grid of corridor
// cells with a risk level 0-4 for each of 49 forecast hours, and checkpoints.
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

export const HOURS = 49;
export const RISK_COLORS = ['#1a9850', '#fee08b', '#fc8d59', '#d73027', '#6a0d5f'];

type LngLat = [number, number];

const ROUTES: LngLat[][] = [
  // southern (I-40 / I-81)
  [[-118.24, 34.05], [-117.02, 34.9], [-111.65, 35.2], [-106.65, 35.08], [-101.83, 35.22], [-97.52, 35.47],
    [-90.05, 35.15], [-86.78, 36.16], [-83.92, 35.96], [-79.94, 37.27], [-76.88, 40.27], [-74.0, 40.71]],
  // central (I-15 / I-70)
  [[-118.24, 34.05], [-115.14, 36.17], [-113.58, 37.1], [-104.99, 39.74], [-94.58, 39.1], [-90.2, 38.63],
    [-86.16, 39.77], [-82.99, 39.96], [-79.99, 40.44], [-74.0, 40.71]],
  // northern (I-15 / I-80)
  [[-118.24, 34.05], [-115.14, 36.17], [-111.89, 40.76], [-104.82, 41.14], [-95.93, 41.26], [-87.63, 41.88],
    [-81.69, 41.5], [-74.0, 40.71]],
];

// Deterministic PRNG so every run builds the same data.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KM_PER_DEG = 111.32;
function distKm(a: LngLat, b: LngLat) {
  const kx = KM_PER_DEG * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * KM_PER_DEG);
}

function densify(line: LngLat[], stepKm: number): LngLat[] {
  const out: LngLat[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const n = Math.max(1, Math.ceil(distKm(a, b) / stepKm));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

// Moving storms: risk = f(sum of gaussians drifting west -> east over 48 h).
function makeRiskField(seed: number) {
  const rnd = mulberry32(seed);
  const storms = Array.from({ length: 9 }, () => ({
    lng: -125 + rnd() * 40, lat: 31 + rnd() * 13,
    vLng: 0.25 + rnd() * 0.45, vLat: (rnd() - 0.5) * 0.15, // degrees per hour
    r: 2 + rnd() * 4, amp: 0.6 + rnd() * 0.9,
  }));
  return (lng: number, lat: number, h: number) => {
    let v = 0;
    for (const s of storms) {
      const dx = lng - (s.lng + s.vLng * h), dy = lat - (s.lat + s.vLat * h);
      v += s.amp * Math.exp(-(dx * dx + dy * dy) / (2 * s.r * s.r));
    }
    return Math.max(0, Math.min(4, Math.floor(v * 3.2)));
  };
}

function cellsForSize(sizeDeg: number, routePts: LngLat[], radiusKm: number) {
  const keys = new Set<string>();
  const r = Math.ceil((radiusKm / KM_PER_DEG) / sizeDeg) + 1;
  for (const p of routePts) {
    const ci = Math.floor(p[0] / sizeDeg), cj = Math.floor(p[1] / sizeDeg);
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const c: LngLat = [(ci + di + 0.5) * sizeDeg, (cj + dj + 0.5) * sizeDeg];
      if (distKm(c, p) <= radiusKm) keys.add(`${ci + di},${cj + dj}`);
    }
  }
  return keys;
}

export interface SpikeData {
  /** Cells with r0..r48 numeric properties and a `risk` array, plus numeric feature ids. */
  cells: FeatureCollection<Polygon>;
  /** risks[cellIndex * HOURS + hour] */
  risks: Uint8Array;
  routes: FeatureCollection<LineString>;
  checkpoints: FeatureCollection<Point>;
  cellSizeDeg: number;
}

export function buildData(targetCells: number): SpikeData {
  const routePts = ROUTES.flatMap((r) => densify(r, 5));
  const radiusKm = 40; // corridor half-width
  // Binary-search the grid size that yields ~targetCells.
  let lo = 0.05, hi = 3, keys = new Set<string>(), size = 1;
  for (let i = 0; i < 30; i++) {
    size = (lo + hi) / 2;
    keys = cellsForSize(size, routePts, Math.max(radiusKm, size * KM_PER_DEG * 0.75));
    if (keys.size > targetCells) lo = size; else hi = size;
  }
  const field = makeRiskField(42);
  const list = [...keys];
  const risks = new Uint8Array(list.length * HOURS);
  const features: Feature<Polygon>[] = list.map((k, idx) => {
    const [i, j] = k.split(',').map(Number);
    const x0 = i * size, y0 = j * size, x1 = x0 + size, y1 = y0 + size;
    const cx = x0 + size / 2, cy = y0 + size / 2;
    const props: Record<string, unknown> = { id: idx };
    const arr: number[] = [];
    for (let h = 0; h < HOURS; h++) {
      const v = field(cx, cy, h);
      risks[idx * HOURS + h] = v;
      props[`r${h}`] = v;
      arr.push(v);
    }
    props.risk = arr;
    props.r = arr[0]; // used by the rebuild baseline and feature-state seed
    return {
      type: 'Feature', id: idx, properties: props,
      geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
    };
  });

  const routes: FeatureCollection<LineString> = {
    type: 'FeatureCollection',
    features: ROUTES.map((r, i) => ({ type: 'Feature', id: i, properties: { route: i }, geometry: { type: 'LineString', coordinates: r } })),
  };
  // Checkpoints every ~25 miles (40 km), risk at a fake ETA (60 mph).
  const cps: Feature<Point>[] = [];
  ROUTES.forEach((r, ri) => {
    densify(r, 40).forEach((p, k) => {
      const etaH = Math.min(48, Math.round((k * 40) / 96.5));
      cps.push({ type: 'Feature', properties: { route: ri, risk: field(p[0], p[1], etaH), eta: etaH }, geometry: { type: 'Point', coordinates: p } });
    });
  });

  return {
    cells: { type: 'FeatureCollection', features },
    risks, routes, checkpoints: { type: 'FeatureCollection', features: cps }, cellSizeDeg: size,
  };
}
