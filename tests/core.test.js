import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Rng, hash32, noise1, mulberry32 } from '../src/core/prng.js';
import {
  textToVisemes, PerformancePipeline, VISEMES, analyzeEnvelope, envelopeToVisemes, syllabify,
} from '../src/core/performance.js';
import { Timeline, trackTemplate } from '../src/core/timeline.js';
import { I18n } from '../src/core/i18n.js';
import { createProject, projectFromJSON, projectToJSON, SCHEMA_VERSION } from '../src/core/project.js';
import { wordsToCues, cuesToSrt } from '../src/core/subtitles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(path.join(here, '..', rel), 'utf8'));
const pt = readJson('src/locales/pt-BR.json');
const en = readJson('src/locales/en.json');

const LINE = 'Bem-vindos ao teatrinho, senhoras e senhores! Eu sou o bobo da corte — e este é o meu palco.';

describe('prng', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i++) expect(a()).toBe(b());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng('one');
    const b = new Rng('two');
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('keeps noise inside [-1, 1] and continuous', () => {
    for (let t = 0; t < 50; t += 0.37) {
      const v = noise1('seed', t, 3);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    const near = Math.abs(noise1('seed', 10) - noise1('seed', 10.001));
    expect(near).toBeLessThan(0.01);
  });

  it('hashes stably', () => {
    expect(hash32('oliteatry')).toBe(hash32('oliteatry'));
    expect(hash32('a')).not.toBe(hash32('b'));
  });

  it('samples log-normal intervals inside sane bounds over many draws', () => {
    const rng = new Rng('blink');
    const values = Array.from({ length: 500 }, () => rng.logNormal(4, 0.5));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(3);
    expect(mean).toBeLessThan(5.5);
  });
});

describe('syllabification + visemes', () => {
  it('splits Portuguese words into syllables', () => {
    expect(syllabify('teatrinho').length).toBeGreaterThanOrEqual(3);
    expect(syllabify('palco').length).toBe(2);
  });

  it('produces ordered, non-overlapping segments covering the line', () => {
    const { segments, duration, words } = textToVisemes(LINE, { locale: 'pt-BR' });
    expect(segments.length).toBeGreaterThanOrEqual(25);
    expect(duration).toBeGreaterThan(4);
    expect(words.length).toBeGreaterThan(10);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].t).toBeGreaterThanOrEqual(segments[i - 1].t);
    }
    for (const s of segments) {
      expect(VISEMES[s.viseme]).toBeDefined();
      expect(s.d).toBeGreaterThan(0);
      expect(s.weight).toBeGreaterThan(0);
    }
  });

  it('honours punctuation with pauses', () => {
    const flat = textToVisemes('abc def', { locale: 'pt-BR' });
    const paused = textToVisemes('abc, def', { locale: 'pt-BR' });
    expect(paused.duration).toBeGreaterThan(flat.duration);
  });

  it('speaks numbers in the active language', () => {
    const { words } = textToVisemes('tomo 3', { locale: 'pt-BR' });
    expect(words.map((w) => w.text).join(' ')).toContain('três');
  });

  it('maps an audio envelope back to visemes', () => {
    const rate = 8000;
    const samples = new Float32Array(rate);
    for (let i = 0; i < rate; i++) {
      const t = i / rate;
      samples[i] = Math.sin(2 * Math.PI * 180 * t) * (Math.sin(t * Math.PI * 2) > 0 ? 0.9 : 0);
    }
    const env = analyzeEnvelope(samples, rate, 20);
    expect(env.rms.length).toBeGreaterThan(40);
    const { segments } = envelopeToVisemes(env);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });
});

describe('performance pipeline', () => {
  const prepared = (seed, opts = {}) => {
    const { segments, duration } = textToVisemes(LINE, { locale: 'pt-BR' });
    return new PerformancePipeline({ seed, archetype: 'theatrical', intensity: 0.7, ...opts })
      .prepare(segments, Math.max(20, duration + 4));
  };

  it('is deterministic across sample orders (scrub-safe)', () => {
    const a = prepared('jester-01');
    const b = prepared('jester-01');
    for (const t of [0, 0.7, 3.3, 9.1, 12.05]) {
      expect(JSON.stringify(a.sample(t))).toBe(JSON.stringify(b.sample(t)));
    }
    const forward = a.sample(8.4);
    a.sample(15);
    a.sample(1);
    expect(JSON.stringify(a.sample(8.4))).toBe(JSON.stringify(forward));
  });

  it('changes when the seed changes', () => {
    const a = prepared('seed-a');
    const b = prepared('seed-b');
    const diffs = [2, 4, 6, 8, 10].filter((t) => JSON.stringify(a.sample(t)) !== JSON.stringify(b.sample(t)));
    expect(diffs.length).toBeGreaterThan(0);
  });

  it('blinks at a human rate', () => {
    const p = prepared('blink-check');
    const inWindow = p.schedule.blinks.filter((b) => b.t >= 0 && b.t <= 60);
    const ratePerMinute = (inWindow.length / 60) * 60;
    expect(ratePerMinute).toBeGreaterThan(6);
    expect(ratePerMinute).toBeLessThan(32);
  });

  it('reports speaking inside a voiced segment and silence outside', () => {
    const p = prepared('speech-check');
    const mid = p.segments[Math.floor(p.segments.length / 2)];
    expect(p.sample(mid.t + mid.d * 0.5).meta.speaking).toBe(true);
    expect(p.sample(p.duration - 0.2).meta.speaking).toBe(false);
  });

  it('opens the jaw only while speaking', () => {
    const p = prepared('jaw-check');
    const mid = p.segments[10];
    const speaking = p.sample(mid.t + mid.d * 0.5).face;
    const silent = p.sample(p.duration - 0.3).face;
    expect(speaking.jaw).toBeGreaterThan(0.05);
    expect(silent.jaw).toBeLessThan(0.12);
  });

  it('never leaves the animated range', () => {
    const p = prepared('range-check', { intensity: 1.4 });
    for (let t = 0; t < p.duration; t += 0.25) {
      const { pose, face } = p.sample(t);
      for (const v of Object.values(pose)) expect(Math.abs(v)).toBeLessThanOrEqual(0.61);
      expect(face.jaw).toBeGreaterThanOrEqual(0);
      expect(face.jaw).toBeLessThanOrEqual(1);
      expect(face.blink).toBeGreaterThanOrEqual(0);
      expect(face.blink).toBeLessThanOrEqual(1);
    }
  });

  it('bakes a dense track', () => {
    const p = prepared('bake-check');
    const frames = p.bake(0.5);
    expect(frames.length).toBeGreaterThan(40);
    expect(frames[0].face).toBeDefined();
  });
});

describe('timeline', () => {
  const makeTimeline = () => {
    const tl = new Timeline({ duration: 12, tracks: trackTemplate() });
    tl.addClip('camera', { start: 0, duration: 4, data: { cam: 'A' } });
    tl.addClip('camera', { start: 4, duration: 4, data: { cam: 'B', in: { type: 'fade', duration: 1 } } });
    tl.addClip('camera', { start: 8, duration: 4, data: { cam: 'A' } });
    return tl;
  };

  it('holds the current camera and eases through transitions', () => {
    const tl = makeTimeline();
    expect(tl.cameraAt(2)).toMatchObject({ to: 'A', progress: 1 });
    const mid = tl.cameraAt(4.5);
    expect(mid.from).toBe('A');
    expect(mid.to).toBe('B');
    expect(mid.progress).toBeGreaterThan(0.3);
    expect(mid.progress).toBeLessThan(0.7);
    expect(tl.cameraAt(9)).toMatchObject({ to: 'A', progress: 1 });
  });

  it('keeps clips sorted and bounded', () => {
    const tl = makeTimeline();
    tl.addClip('voice', { start: 6, duration: 2 });
    const starts = tl.getTrack('camera').clips.map((c) => c.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(tl.durationOf()).toBeGreaterThanOrEqual(12);
  });

  it('removes clips', () => {
    const tl = makeTimeline();
    const id = tl.getTrack('camera').clips[0].id;
    expect(tl.removeClip('camera', id)).toBe(true);
    expect(tl.getTrack('camera').clips.length).toBe(2);
  });
});

describe('i18n', () => {
  const i18n = new I18n({ catalogs: { 'pt-BR': pt, en }, locale: 'pt-BR', fallback: 'en' });

  it('translates and interpolates', () => {
    expect(i18n.t('app.name')).toBe('OLiteatry');
    expect(i18n.t('sound.metrics', { n: 12, s: '3.20', format: false })).toContain('12');
  });

  it('falls back to English for missing keys', () => {
    const partial = new I18n({ catalogs: { 'pt-BR': { 'app.name': 'X' }, en }, locale: 'pt-BR' });
    expect(partial.t('app.name')).toBe('X');
    expect(partial.t('tabs.export')).toBe('Export');
  });

  it('returns the key for unknown entries instead of undefined', () => {
    expect(i18n.t('nope.not.here')).toBe('nope.not.here');
  });

  it('has full key parity between locales', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
  });

  it('notifies locale changes', () => {
    let seen = null;
    const off = i18n.onChange((code) => { seen = code; });
    i18n.setLocale('en');
    expect(seen).toBe('en');
    off();
    i18n.setLocale('pt-BR');
    expect(seen).toBe('en');
  });
});

describe('project format', () => {
  it('round-trips through JSON', () => {
    const p = createProject();
    const back = projectFromJSON(projectToJSON(p));
    expect(back.schema_version).toBe(SCHEMA_VERSION);
    expect(back.timeline.tracks.length).toBe(p.timeline.tracks.length);
    expect(back.cameras.A.focal).toBe(p.cameras.A.focal);
  });

  it('rejects a newer schema instead of guessing', () => {
    const p = createProject();
    p.schema_version = SCHEMA_VERSION + 1;
    expect(() => projectFromJSON(projectToJSON(p))).toThrow(/newer/);
  });

  it('rejects junk', () => {
    expect(() => projectFromJSON('{"nope":true}')).toThrow(/schema_version/);
  });

  it('never stores engine types', () => {
    const json = projectToJSON(createProject());
    expect(json).not.toMatch(/UnityEngine|THREE\.|Matrix4x4|m_LocalPosition/);
  });
});

describe('subtitles', () => {
  it('breaks cues on reading-speed limits', () => {
    const { words } = textToVisemes(LINE.repeat(3), { locale: 'pt-BR' });
    const cues = wordsToCues(words, { maxChars: 42, maxCps: 17 });
    expect(cues.length).toBeGreaterThan(2);
    for (const c of cues) {
      expect(c.end).toBeGreaterThan(c.start);
      expect(c.text.length).toBeLessThanOrEqual(60);
    }
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start);
  });

  it('emits valid SRT', () => {
    const { words } = textToVisemes('Boa noite, plateia.', { locale: 'pt-BR' });
    const srt = cuesToSrt(wordsToCues(words));
    expect(srt).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
  });
});
