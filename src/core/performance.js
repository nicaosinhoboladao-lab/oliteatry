/**
 * Performance pipeline (the key feature).
 *
 * One audio-first clock drives three things at once:
 *   1. visemes  -> jaw / mouth width / lip rounding
 *   2. prosody  -> stress, pauses, speech energy
 *   3. gestures -> a seeded, cooldown-gated finite state machine that decides
 *                  what the body does, so the avatar is never stiff but never
 *                  repetitive either.
 *
 * Design rule: schedules are baked once (sequential RNG), sampling is a pure
 * function of time (stateless). That combination is what makes the performance
 * deterministic AND scrubbable in both directions.
 */
import { Rng, noise1, pulse, clamp, lerp, smoothstep } from './prng.js';

/** 15-viseme set (Oculus/FACS-flavoured) with mouth-shape parameters. */
export const VISEMES = {
  sil: { jaw: 0.04, wide: 0.16, round: 0.06 },
  PP: { jaw: 0.02, wide: 0.10, round: 0.16 },
  FF: { jaw: 0.06, wide: 0.34, round: 0.04 },
  TH: { jaw: 0.14, wide: 0.30, round: 0.02 },
  DD: { jaw: 0.18, wide: 0.26, round: 0.03 },
  kk: { jaw: 0.22, wide: 0.22, round: 0.03 },
  CH: { jaw: 0.15, wide: 0.42, round: 0.10 },
  SS: { jaw: 0.08, wide: 0.46, round: 0.02 },
  nn: { jaw: 0.10, wide: 0.20, round: 0.05 },
  RR: { jaw: 0.15, wide: 0.26, round: 0.30 },
  aa: { jaw: 0.64, wide: 0.46, round: 0.03 },
  E: { jaw: 0.40, wide: 0.60, round: 0.02 },
  I: { jaw: 0.24, wide: 0.55, round: 0.05 },
  O: { jaw: 0.52, wide: 0.24, round: 0.55 },
  U: { jaw: 0.32, wide: 0.12, round: 0.78 },
};

const VOWEL_VISEME = {
  a: 'aa', á: 'aa', à: 'aa', â: 'aa', ã: 'aa', ä: 'aa',
  e: 'E', é: 'E', ê: 'E', ë: 'E',
  i: 'I', í: 'I', î: 'I', ï: 'I', y: 'I', ý: 'I',
  o: 'O', ó: 'O', ô: 'O', õ: 'O', ö: 'O',
  u: 'U', ú: 'U', û: 'U', ü: 'U',
};
const VOWELS = Object.keys(VOWEL_VISEME);

const DIGIT_WORDS = {
  pt: ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
};

const PAUSES = {
  ',': 0.17, ';': 0.22, ':': 0.24, '.': 0.34, '!': 0.36, '?': 0.34,
  '…': 0.5, '—': 0.18, '-': 0.1, '\n': 0.26,
};

function isVowel(ch) {
  return VOWELS.includes(ch.toLowerCase());
}

/** Split a word into rough syllables by vowel groups (locale-free, good enough). */
export function syllabify(word) {
  const chars = [...word];
  const groups = [];
  let start = -1;
  for (let i = 0; i < chars.length; i++) {
    if (isVowel(chars[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      groups.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) groups.push([start, chars.length]);
  if (!groups.length) return [{ text: word, viseme: 'nn', vowel: '' }];

  const bounds = [0];
  for (let g = 1; g < groups.length; g++) {
    const mid = Math.round((groups[g - 1][1] + groups[g][0]) / 2);
    bounds.push(clamp(mid, bounds[bounds.length - 1] + 1, chars.length - 1));
  }
  bounds.push(chars.length);

  const out = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const chunk = chars.slice(bounds[b], bounds[b + 1]).join('');
    const vowel = [...chunk].find(isVowel) ?? '';
    out.push({ text: chunk, viseme: VOWEL_VISEME[vowel?.toLowerCase()] ?? 'nn', vowel });
  }
  return out;
}

/**
 * Text -> timed viseme segments. This is a *scratch* G2P for timing and mouth
 * shapes; a real locale G2P (and a real TTS provider) plugs into the same
 * output shape later.
 */
export function textToVisemes(text, { locale = 'pt-BR', rate = 1, start = 0, baseSyllable = 0.135 } = {}) {
  const lang = locale.slice(0, 2);
  const normalized = String(text)
    .replace(/\d/g, (d) => ` ${DIGIT_WORDS[lang]?.[Number(d)] ?? d} `)
    .replace(/\s+/g, ' ');
  const tokens = normalized.match(/[\p{L}\p{M}'’-]+|[.,;:!?…—\-]|\n/gu) ?? [];
  const segments = [];
  const words = [];
  let t = start;
  const ptBr = lang === 'pt';

  for (const token of tokens) {
    if (PAUSES[token] !== undefined) {
      t += PAUSES[token] / Math.max(0.5, rate);
      continue;
    }
    if (!/[\p{L}\p{M}]/u.test(token)) continue;

    const wordStart = t;
    const sylls = syllabify(token);
    const shout = token === token.toUpperCase() && token.length > 2;
    const weightBase = shout ? 0.9 : token.length >= 7 ? 0.72 : 0.55;
    for (let i = 0; i < sylls.length; i++) {
      const s = sylls[i];
      // pt-BR stress tends to land on the penultimate syllable; English on the first.
      const isStressed = ptBr
        ? i === Math.max(0, sylls.length - 2)
        : i === 0;
      const d = clamp(
        (baseSyllable * (0.78 + 0.055 * s.text.length)) / Math.max(0.5, rate),
        0.075,
        0.26,
      );
      segments.push({
        t: +t.toFixed(4),
        d: +d.toFixed(4),
        viseme: s.viseme,
        weight: clamp(weightBase * (isStressed ? 1 : 0.78), 0.25, 1),
        syllable: s.text,
      });
      t += d;
    }
    words.push({ text: token, t: +wordStart.toFixed(4), end: +t.toFixed(4) });
    t += 0.045 / Math.max(0.5, rate);
  }

  return {
    segments,
    words,
    duration: +(t - start).toFixed(3),
    syllables: segments.length,
    locale,
  };
}

/** RMS envelope over hop windows — used for imported audio lip-sync. */
export function analyzeEnvelope(samples, sampleRate, hopMs = 20) {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const frames = Math.floor(samples.length / hop);
  const times = new Array(frames);
  const rms = new Float32Array(frames);
  let peak = 1e-6;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const v = samples[f * hop + i] ?? 0;
      sum += v * v;
    }
    const v = Math.sqrt(sum / hop);
    rms[f] = v;
    times[f] = (f * hop) / sampleRate;
    if (v > peak) peak = v;
  }
  for (let i = 0; i < rms.length; i++) rms[i] /= peak;
  return { times, rms, peak, hopMs };
}

/** Envelope -> visemes (crude openness mapping; good for scratch tracks). */
export function envelopeToVisemes(envelope, { threshold = 0.09, minDur = 0.06 } = {}) {
  const { times, rms, hopMs } = envelope;
  const segments = [];
  let cur = null;
  for (let i = 0; i < rms.length; i++) {
    const v = rms[i];
    const open = v < threshold ? 0 : v;
    const viseme = open === 0 ? 'sil' : open > 0.55 ? 'aa' : open > 0.32 ? 'E' : 'nn';
    if (!cur || cur.viseme !== viseme) {
      if (cur) {
        cur.d = +(times[i] - cur.t).toFixed(4);
        if (cur.d >= minDur) segments.push(cur);
      }
      cur = { t: +times[i].toFixed(4), d: hopMs / 1000, viseme, weight: clamp(open * 1.2, 0.2, 1) };
    } else {
      cur.d = +(times[i] + hopMs / 1000 - cur.t).toFixed(4);
    }
  }
  if (cur) segments.push(cur);
  return { segments, duration: times.length ? times[times.length - 1] : 0 };
}

export const ARCHETYPES = {
  theatrical: {
    label: 'Teatral',
    gestureAmp: 1.35, gestureRate: 1.15, sway: 1.25, breath: 0.24,
    blinkMedian: 4.4, smile: 0.38, headAmp: 1.3, jitter: 1.0,
  },
  calm: {
    label: 'Sereno',
    gestureAmp: 0.7, gestureRate: 0.7, sway: 0.85, breath: 0.2,
    blinkMedian: 4.0, smile: 0.18, headAmp: 0.8, jitter: 0.8,
  },
  nervous: {
    label: 'Nervoso',
    gestureAmp: 1.0, gestureRate: 1.7, sway: 1.4, breath: 0.32,
    blinkMedian: 2.9, smile: 0.05, headAmp: 1.1, jitter: 1.5,
  },
  weary: {
    label: 'Cansado',
    gestureAmp: 0.5, gestureRate: 0.45, sway: 0.7, breath: 0.16,
    blinkMedian: 5.6, smile: 0.08, headAmp: 0.7, jitter: 0.6,
  },
};

const GESTURE_COOLDOWN = {
  nod: 1.6, tilt: 2.3, shake: 7, shrug: 4.2, leanIn: 5,
  openHand: 2.6, point: 6, handChest: 4.6, lookAway: 3.6,
};
const SPEECH_GESTURES = [
  ['nod', 26], ['tilt', 18], ['openHand', 20], ['handChest', 12],
  ['leanIn', 10], ['shrug', 6], ['point', 5], ['shake', 3],
];
const IDLE_GESTURES = [
  ['tilt', 30], ['lookAway', 24], ['shrug', 14], ['leanIn', 16], ['nod', 16],
];

export function zeroPose() {
  return {
    hipsY: 0, hipsRoll: 0, spineRoll: 0,
    chestPitch: 0, chestYaw: 0, chestRoll: 0,
    neckPitch: 0, neckYaw: 0,
    headPitch: 0, headYaw: 0, headRoll: 0,
    shoulderL: 0, shoulderR: 0,
    armLiftL: 0, armLiftR: 0,
    elbowL: 0, elbowR: 0,
    wristL: 0, wristR: 0,
  };
}

export class PerformancePipeline {
  constructor({ seed = 'oliteatry', archetype = 'theatrical', intensity = 0.7, fps = 60 } = {}) {
    this.seed = seed;
    this.archetype = ARCHETYPES[archetype] ? archetype : 'theatrical';
    this.intensity = intensity;
    this.fps = fps;
    this.segments = [];
    this.duration = 0;
    this.schedule = { blinks: [], saccades: [], gestures: [] };
  }

  get profile() {
    return ARCHETYPES[this.archetype];
  }

  prepare(segments, duration) {
    this.segments = [...segments]
      .filter((s) => s.d > 0)
      .sort((a, b) => a.t - b.t)
      .map((s) => ({ ...s, end: s.t + s.d }));
    this.duration = Math.max(1, duration || 0);
    this._bake();
    return this;
  }

  /** Baked schedules: sequential RNG here, stateless sampling later. */
  _bake() {
    const p = this.profile;
    const I = clamp(this.intensity, 0, 1.5);
    const rng = new Rng(`${this.seed}|schedule|${this.archetype}`);

    // --- blinks: log-normal intervals + utterance-edge clustering + doubles
    const blinks = [];
    let t = rng.range(-0.4, 1.2);
    while (t < this.duration + 1) {
      blinks.push({ t: +t.toFixed(3), dur: +rng.range(0.12, 0.21).toFixed(3), closed: rng.chance(0.1) });
      if (rng.chance(0.1)) blinks.push({ t: +(t + rng.range(0.16, 0.26)).toFixed(3), dur: +rng.range(0.1, 0.16).toFixed(3), closed: false });
      t += clamp(rng.logNormal(p.blinkMedian, 0.5), 1.3, 11);
    }
    for (const s of this.segments) {
      if (rng.chance(0.22)) blinks.push({ t: +(s.end + rng.range(0.02, 0.22)).toFixed(3), dur: 0.16, closed: false });
    }
    blinks.sort((a, b) => a.t - b.t);

    // --- saccades: fixation / saccade alternation, biased to camera when speaking
    const saccades = [];
    let st = 0;
    let px = 0;
    let py = 0;
    while (st < this.duration + 0.5) {
      const dur = rng.range(0.22, 0.5);
      const speak = this._speakingAt(st);
      const toCamera = speak ? 0.6 : 0.35;
      const nx = rng.chance(toCamera) ? rng.range(-0.1, 0.1) : rng.range(-0.55, 0.55);
      const ny = rng.chance(toCamera) ? rng.range(-0.08, 0.1) : rng.range(-0.3, 0.3);
      saccades.push({ t: +st.toFixed(3), dur: +dur.toFixed(3), x: nx, y: ny, px, py });
      px = nx;
      py = ny;
      st += dur;
    }

    // --- gestures: prosody-weighted, cooldown-gated, cooldown + novelty
    const gestures = [];
    const last = Object.create(null);
    let lastAny = -99;
    let recent = [];
    for (const s of this.segments) {
      if (s.viseme === 'sil') continue;
      const pFire = clamp(
        p.gestureRate * (0.18 + 0.55 * I) * (0.45 + 0.75 * s.weight) * 0.42,
        0,
        0.5,
      );
      if (rng.next() > pFire) continue;
      const kind = rng.weighted(SPEECH_GESTURES);

      // Novelty penalty: avoid repeating the last two gesture kinds.
      if (recent.slice(-2).includes(kind) && rng.chance(0.75)) continue;
      if (s.t - (last[kind] ?? -99) < GESTURE_COOLDOWN[kind]) continue;
      if (s.t - lastAny < 0.38) continue;

      last[kind] = s.t;
      lastAny = s.t;
      recent = [...recent, kind].slice(-4);
      gestures.push({
        kind,
        t: +(s.t - 0.05).toFixed(3),
        dur: +rng.range(0.7, 1.7).toFixed(3),
        amp: clamp(0.55 + 0.75 * s.weight, 0.45, 1.3),
        side: rng.chance(0.55) ? 1 : -1,
      });
    }

    // --- idle gestures during long pauses (this is what kills the statue look)
    const gaps = [];
    for (let i = 0; i < this.segments.length - 1; i++) {
      const gap = this.segments[i + 1].t - this.segments[i].end;
      if (gap > 2.4) gaps.push([this.segments[i].end + 0.5, gap - 0.9]);
    }
    for (const [gs, gl] of gaps) {
      let gt = gs + rng.range(0, Math.min(1.2, gl * 0.4));
      while (gt < gs + gl) {
        const kind = rng.weighted(IDLE_GESTURES);
        gestures.push({
          kind,
          t: +gt.toFixed(3),
          dur: +rng.range(1.1, 2.6).toFixed(3),
          amp: rng.range(0.45, 0.9) * (0.6 + 0.6 * I),
          side: rng.chance(0.5) ? 1 : -1,
        });
        gt += rng.range(2.2, 5.5);
      }
    }

    gestures.sort((a, b) => a.t - b.t);
    this.schedule = { blinks, saccades, gestures };
  }

  _speakingAt(t) {
    let lo = 0;
    let hi = this.segments.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid].t <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return false;
    // hysteresis: a 40 ms inter-word gap is not "stop speaking", it is speech
    return t <= this.segments[found].end + 0.18;
  }

  _visemeAt(t, face, expressiveness) {
    const segs = this.segments;
    if (!segs.length) return { speaking: false, viseme: 'sil' };
    let lo = 0;
    let hi = segs.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].t <= t) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) {
      face.jaw = VISEMES.sil.jaw;
      return { speaking: false, viseme: 'sil' };
    }
    const cur = segs[i];
    if (t > cur.end) {
      const next = segs[i + 1];
      const leak = next ? smoothstep(cur.end, cur.end + 0.06, t) : 0;
      const shape = next ? VISEMES[next.viseme] : VISEMES.sil;
      const w = leak * 0.35;
      face.jaw = lerp(VISEMES.sil.jaw, shape.jaw, w) * expressiveness;
      face.wide = lerp(VISEMES.sil.wide, shape.wide, w);
      face.round = lerp(VISEMES.sil.round, shape.round, w);
      return { speaking: false, viseme: 'sil' };
    }
    const shape = VISEMES[cur.viseme] ?? VISEMES.sil;
    const nextShape = VISEMES[segs[i + 1]?.viseme] ?? VISEMES.sil;
    const u = (t - cur.t) / cur.d;
    // mouths open fast, close slow (asymmetric + coarticulation toward the next shape)
    const openEnv = smoothstep(0, 0.22, u) * (1 - smoothstep(0.68, 1.02, u) * 0.45);
    const coart = smoothstep(0.7, 1, u) * 0.4;
    const jaw = lerp(shape.jaw, nextShape.jaw, coart) * openEnv * cur.weight * expressiveness;
    face.jaw = lerp(face.jaw, clamp(jaw, 0, 0.9), 0.92);
    face.wide = lerp(face.wide, lerp(shape.wide, nextShape.wide, coart), 0.5);
    face.round = lerp(face.round, lerp(shape.round, nextShape.round, coart), 0.5);
    return { speaking: true, viseme: cur.viseme };
  }

  _blinkAt(t) {
    let closed = 0;
    for (const b of this.schedule.blinks) {
      if (t < b.t - 0.05 || t > b.t + b.dur + 0.02) continue;
      const u = clamp((t - b.t) / b.dur, 0, 1);
      // close fast (35%), hold, open slower
      closed = Math.max(closed, u < 0.35 ? smoothstep(0, 0.35, u) : 1 - smoothstep(0.35, 1, u));
    }
    return closed;
  }

  _gazeAt(t, face) {
    const list = this.schedule.saccades;
    let i = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k].t <= t) i = k;
      else break;
    }
    if (i < 0) return { x: 0, y: 0 };
    const s = list[i];
    const u = clamp((t - s.t) / s.dur, 0, 1);
    const move = smoothstep(0.6, 0.95, u); // fixation hold, then saccade at the end
    const x = lerp(s.px, s.x, move);
    const y = lerp(s.py, s.y, move);
    face.eyeX = x;
    face.eyeY = y;
    return { x, y };
  }

  _applyGesture(g, u, pose, face, p, I) {
    const env = pulse(u) * g.amp * p.gestureAmp * (0.55 + 0.6 * I);
    const side = g.side;
    switch (g.kind) {
      case 'nod':
        pose.headPitch += 0.11 * env;
        pose.neckPitch += 0.035 * env;
        break;
      case 'tilt':
        pose.headRoll += 0.14 * env * side;
        pose.chestRoll += 0.02 * env * side;
        break;
      case 'shake':
        pose.headYaw += 0.09 * env * Math.sin(u * Math.PI * 4);
        break;
      case 'shrug':
        pose.shoulderL += 0.13 * env;
        pose.shoulderR += 0.13 * env;
        pose.chestPitch -= 0.03 * env;
        break;
      case 'leanIn':
        pose.chestPitch += 0.07 * env;
        pose.neckPitch += 0.03 * env;
        pose.hipsY -= 0.006 * env;
        break;
      case 'openHand':
        if (side > 0) {
          pose.armLiftR += 0.34 * env;
          pose.elbowR -= 0.3 * env;
          pose.wristR += 0.2 * env;
        } else {
          pose.armLiftL += 0.34 * env;
          pose.elbowL -= 0.3 * env;
          pose.wristL += 0.2 * env;
        }
        pose.chestYaw += 0.035 * env * side;
        break;
      case 'point':
        if (side > 0) {
          pose.armLiftR += 0.58 * env;
          pose.elbowR -= 0.06 * env;
        } else {
          pose.armLiftL += 0.58 * env;
          pose.elbowL -= 0.06 * env;
        }
        break;
      case 'handChest':
        if (side > 0) {
          pose.armLiftR += 0.2 * env;
          pose.elbowR -= 0.62 * env;
        } else {
          pose.armLiftL += 0.2 * env;
          pose.elbowL -= 0.62 * env;
        }
        face.brow += 0.1 * env;
        break;
      case 'lookAway':
        face.eyeX = clamp(face.eyeX + 0.5 * env * side, -1, 1);
        pose.headYaw += 0.1 * env * side;
        break;
      default:
        break;
    }
  }

  /** Sample the whole performance at time t (seconds). Pure. */
  sample(t) {
    const p = this.profile;
    const I = clamp(this.intensity, 0, 1.5);
    const expressiveness = 0.7 + 0.45 * I;
    const pose = zeroPose();
    const face = {
      jaw: VISEMES.sil.jaw, wide: VISEMES.sil.wide, round: VISEMES.sil.round,
      blink: 0, brow: 0.12, eyeX: 0, eyeY: 0, smile: p.smile,
    };

    // --- breath: continuous, damped while speaking (people breathe less mid-phrase)
    const speaking = this._speakingAt(t);
    const breathPhase = t * Math.PI * 2 * p.breath;
    const breath = Math.sin(breathPhase) * 0.5 + 0.5;
    const breathAmp = speaking ? 0.72 : 1;
    pose.chestPitch += (breath - 0.5) * 0.04 * breathAmp;
    pose.spineRoll += (breath - 0.5) * 0.007;
    pose.shoulderL -= (breath - 0.5) * 0.022;
    pose.shoulderR -= (breath - 0.5) * 0.022;
    pose.hipsY += (breath - 0.5) * 0.007;

    // --- postural drift (slow, always-on; this is the "not a statue" baseline)
    const sway = noise1(`${this.seed}|sway`, t * 0.22 + 1, 2);
    pose.hipsRoll += sway * 0.03 * p.sway * I;
    pose.spineRoll -= sway * 0.017 * p.sway * I;
    pose.chestYaw += noise1(`${this.seed}|cyaw`, t * 0.17 + 4, 2) * 0.032 * p.sway * I;
    pose.chestPitch += noise1(`${this.seed}|clean`, t * 0.12 + 9, 2) * 0.014;

    // --- head drift + micro jitter
    pose.headPitch += noise1(`${this.seed}|hp`, t * 0.19 + 2, 2) * 0.055 * p.headAmp;
    pose.headYaw += noise1(`${this.seed}|hy`, t * 0.15 + 7, 2) * 0.07 * p.headAmp;
    pose.headRoll += noise1(`${this.seed}|hr`, t * 0.13 + 11, 2) * 0.045 * p.headAmp;
    pose.headPitch += noise1(`${this.seed}|hj`, t * 1.9 + 3, 1) * 0.004 * p.jitter;
    pose.headYaw += noise1(`${this.seed}|hj2`, t * 2.3 + 5, 1) * 0.005 * p.jitter;

    // --- gaze: eyes lead, head follows a little (natural coupling)
    const gaze = this._gazeAt(t, face);
    pose.headYaw += gaze.x * 0.09;
    pose.neckYaw += gaze.x * 0.04;
    pose.headPitch += -gaze.y * 0.05;

    // --- visemes
    const vis = this._visemeAt(t, face, expressiveness);

    // --- blink + brow coupling
    face.blink = this._blinkAt(t);
    face.brow = clamp(face.brow + (speaking ? 0.08 : 0) + (1 - face.blink) * 0.02, 0, 1);
    if (face.blink > 0.5) face.brow += 0.06;

    // --- gestures (baked schedule, sampled by envelope)
    let activeGesture = null;
    for (const g of this.schedule.gestures) {
      if (t < g.t || t > g.t + g.dur) continue;
      const u = (t - g.t) / g.dur;
      this._applyGesture(g, u, pose, face, p, I);
      if (!activeGesture || g.amp > activeGesture.amp) activeGesture = g;
    }

    // --- emphasis: speaking adds a subtle forward lean and brow activity
    if (speaking) {
      pose.chestPitch += 0.012 * expressiveness;
      face.brow = clamp(face.brow + 0.06, 0, 1);
    }

    // --- clamp to sane joint ranges
    for (const k of Object.keys(pose)) {
      const lim = k === 'hipsY' ? 0.02 : 0.6;
      pose[k] = clamp(pose[k], -lim, lim);
    }
    face.jaw = clamp(face.jaw, 0, 0.95);
    face.wide = clamp(face.wide, 0, 1);
    face.round = clamp(face.round, 0, 1);

    const state = speaking
      ? (this._visemeEnergy(t) > 0.62 ? 'speak_emphatic' : 'speak_calm')
      : (this.schedule.gestures.some((g) => t >= g.t && t <= g.t + g.dur) ? 'idle_gesture' : 'rest');

    return {
      face,
      pose,
      meta: {
        speaking: vis.speaking,
        viseme: vis.viseme,
        state,
        gesture: activeGesture ? activeGesture.kind : null,
        archetype: this.archetype,
      },
    };
  }

  _visemeEnergy(t) {
    for (const s of this.segments) {
      if (t >= s.t && t <= s.end) return s.weight;
    }
    return 0;
  }

  /** Flatten the whole stack to a dense track (used by export + tests). */
  bake(step = 1 / 30) {
    const frames = [];
    for (let t = 0; t <= this.duration + 1e-6; t += step) {
      frames.push({ t: +t.toFixed(4), ...this.sample(t) });
    }
    return frames;
  }
}
