/**
 * Project format v1. Engine-neutral by construction: no renderer types, no
 * matrices, no Unity/three objects. Anything that leaks an engine type here
 * breaks the portability promise (see docs/ARCHITECTURE.md, decision D4).
 */
import { Timeline, DEFAULT_FPS, trackTemplate } from './timeline.js';
import { textToVisemes } from './performance.js';

export const SCHEMA_VERSION = 1;

export const DEMO_LINE =
  'Bem-vindos ao teatrinho, senhoras e senhores! Eu sou o bobo da corte — e este é o meu palco. ' +
  'Aqui, cada gesto é ensaiado... mas nenhum parece ensaiado.';

export const FRAMINGS = {
  wide: { label: 'Plano geral', focal: 28, height: 1.32, distance: 4.6, lookY: 1.12 },
  medium: { label: 'Plano médio', focal: 42, height: 1.46, distance: 2.9, lookY: 1.3 },
  close: { label: 'Primeiro plano', focal: 55, height: 1.52, distance: 2.7, lookY: 1.44 },
  low: { label: 'Contra-plongée', focal: 35, height: 0.75, distance: 3.4, lookY: 1.5 },
  high: { label: 'Plongée', focal: 35, height: 2.6, distance: 3.4, lookY: 1.1 },
};

export function createProject() {
  const timeline = new Timeline({ duration: 18, fps: DEFAULT_FPS, tracks: trackTemplate() });
  timeline.addClip('camera', {
    id: 'cam_a_1', start: 0, duration: 6.4, label: 'A · Plano geral',
    data: { cam: 'A', in: { type: 'cut', duration: 0 } },
  });
  timeline.addClip('camera', {
    id: 'cam_b_1', start: 6.4, duration: 5.6, label: 'B · Primeiro plano',
    data: { cam: 'B', in: { type: 'wipe', duration: 0.7, easing: 'easeInOut' } },
  });
  timeline.addClip('camera', {
    id: 'cam_a_2', start: 12.0, duration: 6.0, label: 'A · Retorno',
    data: { cam: 'A', in: { type: 'fade', duration: 0.5, easing: 'easeInOut' } },
  });

  const { segments, duration } = textToVisemes(DEMO_LINE, { locale: 'pt-BR', start: 0 });
  timeline.addClip('voice', {
    id: 'voice_1', start: 1.0, duration: +(duration + 0.2).toFixed(3), label: 'Fala de abertura',
    data: {
      text: DEMO_LINE,
      locale: 'pt-BR',
      rate: 1,
      visemes: segments,
      source: 'scratch-synth',
    },
  });
  timeline.addClip('motion', {
    id: 'motion_1', start: 0, duration: 18, label: 'Idle · Teatral',
    data: { archetype: 'theatrical', intensity: 0.72, seed: 'jester-01' },
  });

  return {
    schema_version: SCHEMA_VERSION,
    meta: {
      name: 'Palco sem nome',
      created: new Date().toISOString(),
      app: 'OLiteatry 0.1.0',
      engine: 'three.js reference host',
      locale: 'pt-BR',
    },
    stage: { preset: 'courtyard', floorTone: 0.55, ambient: 0.34, fog: 0.18 },
    lighting: {
      key: { intensity: 2.2, color: '#ffe2bd', azimuth: 38, elevation: 42 },
      fill: { intensity: 0.65, color: '#8f6bd6', azimuth: -52, elevation: 18 },
      rim: { intensity: 1.6, color: '#c9a227', azimuth: 168, elevation: 26 },
    },
    cameras: {
      A: { framing: 'wide', focal: 28, height: 1.32, distance: 4.6, lookY: 1.12, shake: 0.15 },
      B: { framing: 'close', focal: 55, height: 1.52, distance: 2.7, lookY: 1.44, shake: 0.3 },
    },
    post: {
      bloom: 0.38, bloomThreshold: 0.72, dof: 0.35, exposure: 1.02, contrast: 1.06,
      saturation: 1.04, vignette: 0.42, grain: 0.16, dither: 0.0, scanlines: 0.0, ps2: false,
    },
    performance: { archetype: 'theatrical', intensity: 0.72, seed: 'jester-01', liveMic: false },
    voice: { provider: 'scratch-synth', locale: 'pt-BR', rate: 1, pitch: 0.92 },
    localization: { locale: 'pt-BR', fallback: 'en', catalogs: ['pt-BR', 'en'] },
    assets: [],
    timeline: {
      duration: timeline.duration,
      fps: timeline.fps,
      tracks: timeline.tracks,
    },
  };
}

export function timelineFromProject(project) {
  const t = project?.timeline ?? {};
  const tracks = t.tracks ?? trackTemplate();
  // the animation track arrived after the original schema — ensure it exists so
  // projects saved by older builds can still hold animation clips
  if (!tracks.some((tr) => tr.id === 'anim')) {
    const at = tracks.findIndex((tr) => tr.id === 'sfx');
    const anim = { id: 'anim', kind: 'animation', label: 'Animação', clips: [] };
    if (at >= 0) tracks.splice(at, 0, anim);
    else tracks.push(anim);
  }
  return new Timeline({
    duration: t.duration ?? 18,
    fps: t.fps ?? DEFAULT_FPS,
    tracks,
  });
}

export function projectToJSON(project, pretty = true) {
  return JSON.stringify(project, null, pretty ? 2 : 0);
}

export function projectFromJSON(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  if (!data || typeof data !== 'object') throw new Error('not a project file');
  const version = Number(data.schema_version ?? 0);
  if (!Number.isFinite(version) || version < 1) throw new Error('missing schema_version');
  if (version > SCHEMA_VERSION) {
    throw new Error(`project schema v${version} is newer than this build (v${SCHEMA_VERSION})`);
  }
  let node = data;
  if (version < SCHEMA_VERSION) node = migrate(node, version);
  return node;
}

/** One function per version hop, both directions tested by fixtures. */
export function migrate(project, from) {
  let p = project;
  if (from < 1) {
    p = { ...p, schema_version: 1 };
  }
  return p;
}

/** Rebuild the derived viseme track for a voice clip after an edit. */
export function refreshVoiceClip(clip, locale = 'pt-BR', rate = 1) {
  const text = clip?.data?.text ?? '';
  const { segments, duration } = textToVisemes(text, { locale, rate, start: 0 });
  clip.data.visemes = segments;
  clip.duration = +(duration + 0.2).toFixed(3);
  return clip;
}

export function projectStats(project) {
  const tracks = project?.timeline?.tracks ?? [];
  const clips = tracks.reduce((n, t) => n + t.clips.length, 0);
  const voices = tracks.find((t) => t.id === 'voice')?.clips ?? [];
  const syllables = voices.reduce((n, c) => n + (c.data?.visemes?.length ?? 0), 0);
  return { tracks: tracks.length, clips, syllables };
}
