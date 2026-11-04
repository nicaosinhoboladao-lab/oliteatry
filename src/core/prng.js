/**
 * Deterministic randomness. Everything in OLiteatry that "looks random" must be
 * reproducible from a seed: same project + same build => same frames.
 * No Math.random() anywhere in src/core.
 */

/** FNV-1a 32-bit over a string. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small, fast, seedable PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? hash32(seed) : seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  next() {
    return this._next();
  }
  range(a, b) {
    return a + (b - a) * this._next();
  }
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }
  pick(arr) {
    return arr[Math.floor(this._next() * arr.length) % arr.length];
  }
  chance(p) {
    return this._next() < p;
  }
  /** Log-normal sample, useful for human inter-event intervals. */
  logNormal(median, sigma) {
    // Box-Muller from the uniform stream (deterministic given the seed).
    const u1 = Math.max(1e-9, this._next());
    const u2 = this._next();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * n);
  }
  /** Weighted pick: entries are [value, weight]. */
  weighted(entries) {
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = this._next() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1][0];
  }
}

function hashLattice(seed, i) {
  let h = (seed ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Stateless 1-D value noise in [-1, 1]. Because it is a pure function of
 * (seed, t) it can be sampled at any time, forwards or backwards, which is what
 * makes scrubbing a procedural performance safe.
 */
export function noise1(seed, t, octaves = 2) {
  const s = typeof seed === 'string' ? hash32(seed) : seed >>> 0;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const x = t * freq;
    const i = Math.floor(x);
    const f = x - i;
    const k = s + o * 0x27d4eb2d;
    const a = hashLattice(k, i);
    const b = hashLattice(k, i + 1);
    const v = (a + (b - a) * smoother(f)) * 2 - 1;
    sum += v * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm === 0 ? 0 : sum / norm;
}

/** Positive-only noise in [0,1], handy for amplitudes. */
export function noise01(seed, t, octaves = 2) {
  return noise1(seed, t, octaves) * 0.5 + 0.5;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth bump 0..1..0 across [0,1]; the canonical gesture envelope. */
export function pulse(u) {
  if (u <= 0 || u >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * u), 1.35);
}
