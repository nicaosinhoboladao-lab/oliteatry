/**
 * OLiteatry renderer entry point: shell, inspector, timeline, transport and the
 * frame loop. All domain logic lives in ../core (engine-free, unit-tested);
 * this file is the host.
 */
import { I18n } from '../core/i18n.js';
import * as THREE from './vendor/three.module.js';
import { PerformancePipeline, ARCHETYPES } from '../core/performance.js';
import {
  createProject, projectFromJSON, projectToJSON, refreshVoiceClip, timelineFromProject,
  DEMO_LINE, FRAMINGS,
} from '../core/project.js';
import { wordsToCues, cuesToSrt } from '../core/subtitles.js';
import { clamp } from '../core/prng.js';
import { Stage } from './stage.js';
import { VoiceEngine, CanvasRecorder, encodeStills } from './voice.js';
import { loadModelAsset, retargetClips, hasSkeleton } from './imports.js';

const api = window.oliteatry ?? {
  isDesktop: false,
  saveProject: async () => ({ canceled: true }),
  openProject: async () => ({ canceled: true }),
  saveBinary: async () => ({ canceled: true }),
  saveText: async () => ({ canceled: true }),
  importModel: async () => ({ canceled: true }),
  readModel: async () => ({ canceled: true }),
  minimize() {}, maximize() {}, close() {}, log() {},
};

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const ICONS = {
  stage: `<svg viewBox="0 0 24 24"><rect x="2.5" y="4.5" width="19" height="12" rx="1"/><path d="M7 20h10M12 16.5V20"/></svg>`,
  actor: `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.8 3.1-5.8 7-5.8s7 2 7 5.8"/></svg>`,
  camera: `<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="13" height="10" rx="1.5"/><path d="M15.5 11.5l6-3.2v7.4l-6-3.2z"/></svg>`,
  light: `<svg viewBox="0 0 24 24"><path d="M9.5 17.5h5M10 20.5h4"/><path d="M12 3a6 6 0 00-3.6 10.8V17h7.2v-3.2A6 6 0 0012 3z"/></svg>`,
  sound: `<svg viewBox="0 0 24 24"><path d="M4 10v4M8 7.5v9M12 4.5v15M16 8.5v7M20 11v2"/></svg>`,
  export: `<svg viewBox="0 0 24 24"><path d="M12 15V3.5M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/></svg>`,
  objects: `<svg viewBox="0 0 24 24"><path d="M12 2l8 4.5v9L12 20l-8-4.5v-9z"/><path d="M12 2v9M4 6.5l8 4.5 8-4.5M12 20v-9"/></svg>`,
};

const TABS = [
  { id: 'stage', icon: 'stage' },
  { id: 'actor', icon: 'actor' },
  { id: 'objects', icon: 'objects' },
  { id: 'camera', icon: 'camera' },
  { id: 'light', icon: 'light' },
  { id: 'sound', icon: 'sound' },
  { id: 'export', icon: 'export' },
];

const state = {
  project: null,
  timeline: null,
  pipeline: null,
  i18n: null,
  time: 0,
  playing: false,
  loop: true,
  playStart: 0,
  playFrom: 0,
  frames: 0,
  fps: 60,
  errors: [],
  activeTab: 'stage',
  selectedClip: null,
  exportScale: 1,
  exportFps: 60,
  recording: false,
  recorder: null,
  exporting: false,
  stopMotion: { frames: [], onion: true },
  mic: { on: false, level: 0, stream: null, src: null, analyser: null },
  refs: {},
};

let stage = null;
let voice = null;
let canvas = null;
let viewport = null;

/* --------------------------------- helpers -------------------------------- */

function toast(message, kind = 'info') {
  const box = $('#toasts');
  const node = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(8px)';
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

function tcText(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function timecodeHud(t, fps) {
  const f = Math.round((t % 1) * fps);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

const voiceClip = () => state.timeline?.getTrack('voice')?.clips[0] ?? null;

function collectSegments() {
  const clips = state.timeline?.getTrack('voice')?.clips ?? [];
  const out = [];
  for (const c of clips) {
    for (const s of c.data?.visemes ?? []) out.push({ ...s, t: s.t + c.start });
  }
  return out;
}

function rebuildPipeline() {
  const perf = state.project.performance;
  state.pipeline = new PerformancePipeline({
    seed: perf.seed,
    archetype: perf.archetype,
    intensity: perf.intensity,
    fps: state.timeline.fps,
  }).prepare(collectSegments(), state.timeline.durationOf());
}

/* ------------------------------ inspector UI ------------------------------ */

function rangeField(labelKey, value, opts = {}) {
  const { min = 0, max = 1, step = 0.01, format = (v) => Number(v).toFixed(2), onInput } = opts;
  const out = el('output', {}, format(value));
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onInput?.(v);
  });
  return el('label', { class: 'field' },
    el('div', { class: 'row' }, el('span', { class: 'field-label', 'data-loc': labelKey }), out),
    input);
}

function selectField(labelKey, value, options, onChange, opts = {}) {
  const sel = el('select');
  for (const [val, optKey] of options) {
    sel.append(el('option', { value: val, 'data-loc': optKey, selected: val === value ? '' : undefined }, state.i18n.t(optKey)));
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return el('label', { class: 'field' + (opts.inline ? ' inline' : '') },
    el('span', { class: 'field-label', 'data-loc': labelKey }), sel);
}

function toggleField(labelKey, value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(value);
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'toggle' },
    el('span', { 'data-loc': labelKey }),
    input,
    el('span', { class: 'track' }));
}

function colorField(labelKey, value, onChange) {
  const input = el('input', { type: 'color', value });
  const out = el('span', { class: 'mono' }, value);
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onChange(input.value);
  });
  return el('label', { class: 'field' },
    el('div', { class: 'row' }, el('span', { class: 'field-label', 'data-loc': labelKey }), out),
    el('div', { class: 'color-row' }, input));
}

function section(key) {
  return el('div', { class: 'section-title' }, el('span', { 'data-loc': key }));
}

function buttonField(key, onClick, cls = 'btn wide') {
  const b = el('button', { class: cls, 'data-loc': key });
  b.addEventListener('click', onClick);
  return b;
}

function h2(key) {
  return el('h2', { 'data-loc': key });
}

function panelStage() {
  const p = state.project;
  const box = el('div', { class: 'panel' + (state.activeTab === 'stage' ? ' active' : ''), 'data-panel': 'stage' });
  box.append(h2('stage.title'));
  box.append(selectField('stage.preset', p.stage.preset, [
    ['courtyard', 'stage.preset.courtyard'],
    ['void', 'stage.preset.void'],
    ['tavern', 'stage.preset.tavern'],
  ], (v) => {
    p.stage.preset = v;
    stage.applyStage(p.stage);
  }));
  box.append(rangeField('stage.ambient', p.stage.ambient, {
    min: 0, max: 1, step: 0.01, onInput: (v) => { p.stage.ambient = v; stage.applyStage(p.stage); },
  }));
  box.append(rangeField('stage.fog', p.stage.fog, {
    min: 0, max: 1, step: 0.01, onInput: (v) => { p.stage.fog = v; stage.applyStage(p.stage); },
  }));
  box.append(rangeField('stage.floor', p.stage.floorTone, {
    min: 0, max: 1, step: 0.01, onInput: (v) => { p.stage.floorTone = v; stage.applyStage(p.stage); },
  }));

  box.append(section('stage.post'));
  const postKeys = [
    ['stage.bloom', 'bloom', 0, 1.5, 0.01],
    ['stage.bloomThreshold', 'bloomThreshold', 0, 1, 0.01],
    ['stage.dof', 'dof', 0, 1, 0.01],
    ['stage.exposure', 'exposure', 0.3, 2.2, 0.01],
    ['stage.contrast', 'contrast', 0.5, 1.8, 0.01],
    ['stage.saturation', 'saturation', 0, 2, 0.01],
    ['stage.vignette', 'vignette', 0, 1, 0.01],
    ['stage.grain', 'grain', 0, 0.6, 0.005],
  ];
  for (const [labelKey, key, min, max, step] of postKeys) {
    box.append(rangeField(labelKey, p.post[key], {
      min, max, step,
      onInput: (v) => { p.post[key] = v; stage.setPostParams(p.post); },
    }));
  }
  box.append(toggleField('stage.ps2', p.post.ps2, (v) => {
    p.post.ps2 = v;
    stage.setPostParams(p.post);
    stage.setQuality(v ? 0.55 : 1);
  }));
  box.append(el('p', { class: 'hint', 'data-loc': 'stage.ps2.hint' }));
  return box;
}

function panelActor() {
  const p = state.project;
  const box = el('div', { class: 'panel' + (state.activeTab === 'actor' ? ' active' : ''), 'data-panel': 'actor' });
  box.append(h2('actor.title'));

  box.append(selectField('actor.archetype', p.performance.archetype,
    Object.entries(ARCHETYPES).map(([id, def]) => [id, `actor.archetype.${id}`]),
    (v) => {
      p.performance.archetype = v;
      rebuildPipeline();
      renderTimeline();
    }));

  box.append(rangeField('actor.intensity', p.performance.intensity, {
    min: 0, max: 1.4, step: 0.01,
    onInput: (v) => { p.performance.intensity = v; rebuildPipeline(); },
  }));

  const seedInput = el('input', { type: 'text', value: p.performance.seed, spellcheck: 'false' });
  seedInput.addEventListener('change', () => {
    p.performance.seed = seedInput.value || 'jester-01';
    rebuildPipeline();
  });
  box.append(el('label', { class: 'field' },
    el('span', { class: 'field-label', 'data-loc': 'actor.seed' }), seedInput));
  box.append(buttonField('actor.reseed', () => {
    p.performance.seed = Math.random().toString(36).slice(2, 8);
    rebuildPipeline();
    buildInspector();
  }, 'btn wide'));

  box.append(toggleField('actor.liveMic', p.performance.liveMic, async (v) => {
    p.performance.liveMic = v;
    await setMic(v);
  }));
  box.append(el('p', { class: 'hint', 'data-loc': 'actor.liveMic.hint' }));

  box.append(section('actor.readout'));
  const st = el('dd', {}, '—');
  const vs = el('dd', {}, '—');
  const gs = el('dd', {}, '—');
  state.refs.actorState = st;
  state.refs.actorViseme = vs;
  state.refs.actorGesture = gs;
  box.append(el('dl', { class: 'readout' },
    el('dt', { 'data-loc': 'actor.state' }), st,
    el('dt', { 'data-loc': 'actor.viseme' }), vs,
    el('dt', { 'data-loc': 'actor.gesture' }), gs));
  box.append(el('p', { class: 'hint', 'data-loc': 'actor.determinism' }));
  return box;
}

function cameraBlock(id) {
  const cfg = state.project.cameras[id];
  const box = el('div', { class: 'section' });
  box.append(section(id === 'A' ? 'camera.a' : 'camera.b'));
  const framingOptions = Object.keys(FRAMINGS).map((k) => [k, `camera.framing.${k}`]);
  box.append(selectField('camera.framing', cfg.framing, framingOptions, (v) => {
    cfg.framing = v;
    const preset = FRAMINGS[v];
    if (preset) {
      cfg.focal = preset.focal;
      cfg.height = preset.height;
      cfg.distance = preset.distance;
      cfg.lookY = preset.lookY;
    }
    stage.setCameras(state.project.cameras);
    buildInspector();
  }));
  const rows = [
    ['camera.focal', 'focal', 14, 110, 1, (v) => v.toFixed(0) + 'mm'],
    ['camera.height', 'height', 0.4, 3.2, 0.02, (v) => v.toFixed(2) + 'm'],
    ['camera.distance', 'distance', 1.2, 8, 0.05, (v) => v.toFixed(2) + 'm'],
    ['camera.lookY', 'lookY', 0.6, 2, 0.02, (v) => v.toFixed(2) + 'm'],
    ['camera.shake', 'shake', 0, 1, 0.01, (v) => v.toFixed(2)],
  ];
  for (const [labelKey, key, min, max, step, format] of rows) {
    box.append(rangeField(labelKey, cfg[key], {
      min, max, step, format,
      onInput: (v) => { cfg[key] = v; stage.setCameras(state.project.cameras); },
    }));
  }
  return box;
}

function panelCamera() {
  const box = el('div', { class: 'panel' + (state.activeTab === 'camera' ? ' active' : ''), 'data-panel': 'camera' });
  box.append(h2('camera.title'));
  box.append(cameraBlock('A'));
  box.append(el('div', { class: 'divider' }));
  box.append(cameraBlock('B'));
  box.append(el('div', { class: 'divider' }));
  box.append(selectField('camera.transition', state.project.cameraTransition ?? 'fade', [
    ['cut', 'camera.transition.cut'],
    ['fade', 'camera.transition.fade'],
    ['wipe', 'camera.transition.wipe'],
  ], (v) => { state.project.cameraTransition = v; }));
  box.append(buttonField('camera.addCut', () => addCut(state.project.cameraTransition ?? 'fade')));
  return box;
}

function lightBlock(id, key) {
  const cfg = state.project.lighting[key];
  const box = el('div', { class: 'section' });
  box.append(section(`light.${key}`));
  box.append(rangeField('light.intensity', cfg.intensity, {
    min: 0, max: 6, step: 0.05,
    onInput: (v) => { cfg.intensity = v; stage.applyLighting(state.project.lighting); },
  }));
  box.append(colorField('light.color', cfg.color, (v) => {
    cfg.color = v;
    stage.applyLighting(state.project.lighting);
  }));
  if (key !== 'fill') {
    box.append(rangeField('light.azimuth', cfg.azimuth, {
      min: -180, max: 180, step: 1, format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { cfg.azimuth = v; stage.applyLighting(state.project.lighting); },
    }));
    box.append(rangeField('light.elevation', cfg.elevation, {
      min: -10, max: 85, step: 1, format: (v) => `${Math.round(v)}°`,
      onInput: (v) => { cfg.elevation = v; stage.applyLighting(state.project.lighting); },
    }));
  }
  return box;
}

function panelLight() {
  const box = el('div', { class: 'panel' + (state.activeTab === 'light' ? ' active' : ''), 'data-panel': 'light' });
  box.append(h2('light.title'));
  box.append(lightBlock('key', 'key'));
  box.append(lightBlock('fill', 'fill'));
  box.append(lightBlock('rim', 'rim'));
  return box;
}

function panelSound() {
  const box = el('div', { class: 'panel' + (state.activeTab === 'sound' ? ' active' : ''), 'data-panel': 'sound' });
  box.append(h2('sound.title'));

  const clip = voiceClip();
  const area = el('textarea', { spellcheck: 'false', placeholder: state.i18n.t('sound.line.ph') });
  area.value = clip?.data?.text ?? DEMO_LINE;
  area.addEventListener('input', () => {
    if (clip) clip.data.text = area.value;
    state.draftLine = area.value;
  });
  box.append(el('label', { class: 'field' },
    el('span', { class: 'field-label', 'data-loc': 'sound.line' }), area));

  box.append(rangeField('sound.rate', state.project.voice.rate, {
    min: 0.6, max: 1.7, step: 0.01,
    onInput: (v) => { state.project.voice.rate = v; },
  }));
  box.append(rangeField('sound.pitch', state.project.voice.pitch, {
    min: 0.6, max: 1.5, step: 0.01,
    onInput: (v) => { state.project.voice.pitch = v; },
  }));

  box.append(selectField('sound.provider', state.project.voice.provider, [
    ['scratch-synth', 'sound.provider.scratch'],
    ['elevenlabs', 'sound.provider.eleven'],
  ], (v) => {
    state.project.voice.provider = v;
    if (v === 'elevenlabs') {
      toast('ElevenLabs: chave necessária — adaptador ITtsProvider pronto, chave não configurada.', 'error');
    }
  }));
  box.append(el('p', { class: 'hint', 'data-loc': 'sound.provider.hint' }));

  box.append(buttonField('sound.rebuild', () => rebuildVoice(), 'btn wax wide'));

  const metrics = el('p', { class: 'hint gold' });
  const n = clip?.data?.visemes?.length ?? 0;
  metrics.textContent = state.i18n.t('sound.metrics', { n, s: (clip?.duration ?? 0).toFixed(2) });
  state.refs.soundMetrics = metrics;
  box.append(metrics);

  box.append(el('div', { class: 'divider' }));
  box.append(buttonField('sound.srt', () => exportSrt()));
  box.append(el('p', { class: 'hint', 'data-loc': 'sound.srt.hint' }));
  return box;
}

function panelExport() {
  const box = el('div', { class: 'panel' + (state.activeTab === 'export' ? ' active' : ''), 'data-panel': 'export' });
  box.append(h2('export.title'));

  box.append(selectField('export.resolution', String(state.exportScale), [
    ['1', 'x1'],
    ['1.5', 'x1.5'],
    ['2', 'x2'],
  ], (v) => {
    state.exportScale = Number(v);
    applySize();
    updateExportSummary();
  }));
  box.append(selectField('export.fps', String(state.exportFps), [
    ['24', '24'],
    ['30', '30'],
    ['60', '60'],
  ], (v) => { state.exportFps = Number(v); }));

  const summary = el('p', { class: 'hint gold' });
  state.refs.exportSummary = summary;
  box.append(summary);

  box.append(el('div', { class: 'divider' }));
  const recBtn = el('button', { class: 'btn wax wide', 'data-loc': 'export.record' });
  recBtn.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  state.refs.recBtn = recBtn;
  box.append(recBtn);
  box.append(buttonField('export.still', () => exportStill()));
  box.append(el('p', { class: 'hint', 'data-loc': 'export.hint' }));

  box.append(el('div', { class: 'divider' }));
  box.append(section('export.stopmotion'));
  box.append(buttonField('export.capture', () => captureStill(), 'btn wide'));
  const framesLabel = el('p', { class: 'hint gold' });
  framesLabel.textContent = state.i18n.t('export.frames', { n: state.stopMotion.frames.length });
  state.refs.framesLabel = framesLabel;
  box.append(framesLabel);
  box.append(toggleField('export.onion', state.stopMotion.onion, (v) => {
    state.stopMotion.onion = v;
    updateOnion();
  }));
  box.append(buttonField('export.sequence', () => exportStopMotion(), 'btn wide'));
  box.append(buttonField('export.clear', () => {
    state.stopMotion.frames = [];
    updateOnion();
  }, 'btn wide'));
  return box;
}

/* ------------------------------ objects panel ----------------------------- */

const TRANSFORM_MODES = [
  ['translate', 'objects.mode.move'],
  ['rotate', 'objects.mode.rotate'],
  ['scale', 'objects.mode.scale'],
];

const round = (v, d = 3) => Number(v.toFixed(d));

function setGizmoMode(mode) {
  stage.setTransformMode(mode);
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === mode));
}

function syncFreecamToggle() {
  if (state.refs.freecamToggle) state.refs.freecamToggle.checked = stage.freecam;
}

function panelObjects() {
  const box = el('div', { class: 'panel' + (state.activeTab === 'objects' ? ' active' : ''), 'data-panel': 'objects' });
  box.append(h2('objects.title'));

  box.append(buttonField('objects.importModel', () => importModel()));
  box.append(buttonField('objects.importAnimation', () => importAnimation()));
  const fcInput = el('input', { type: 'checkbox' });
  fcInput.checked = stage.freecam;
  fcInput.addEventListener('change', () => stage.setFreecam(fcInput.checked));
  state.refs.freecamToggle = fcInput;
  box.append(el('label', { class: 'toggle' },
    el('span', { 'data-loc': 'objects.freecam' }),
    fcInput,
    el('span', { class: 'track' })));
  box.append(el('p', { class: 'hint', 'data-loc': 'objects.freecam.hint' }));

  box.append(section('objects.gizmo'));
  const modeRow = el('div', { class: 'seg' });
  for (const [mode, key] of TRANSFORM_MODES) {
    const b = el('button', { class: 'seg-btn' + (stage.transformMode === mode ? ' active' : ''), 'data-gizmo': mode, 'data-loc': key });
    b.addEventListener('click', () => setGizmoMode(mode));
    modeRow.append(b);
  }
  box.append(modeRow);

  box.append(section('objects.list'));
  box.append(el('div', { class: 'obj-list' }, (state.refs.objList = el('div'))));

  box.append(section('objects.props'));
  box.append(el('div', { class: 'obj-props' }, (state.refs.objProps = el('div'))));
  return box;
}

function renderObjectList() {
  const host = state.refs.objList;
  if (!host) return;
  host.innerHTML = '';
  if (!stage.objects.length) {
    host.append(el('p', { class: 'hint', 'data-loc': 'objects.empty' }));
    return;
  }
  for (const entry of stage.objects) {
    const row = el('div', { class: 'obj-row' + (stage.selectedId === entry.id ? ' selected' : '') });
    const name = el('button', { class: 'obj-name', title: entry.source ?? '' }, entry.name);
    name.addEventListener('click', () => selectObjectById(entry.id));
    const eye = el('button', {
      class: 'obj-eye' + (entry.object.visible ? '' : ' off'),
      title: state.i18n.t('objects.visibility'),
    }, entry.object.visible ? '◉' : '○');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      entry.object.visible = !entry.object.visible;
      renderObjectList();
    });
    row.append(name, eye);
    if (!entry.builtin) {
      const del = el('button', { class: 'obj-del', title: state.i18n.t('objects.delete') }, '✕');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteObject(entry);
      });
      row.append(del);
    }
    host.append(row);
  }
}

function selectObjectById(id) {
  stage.selectObject(id);
  setTab('objects');
  renderObjectList();
  renderObjectProps();
}

function syncTransformInputs() {
  const entry = stage.getSelected();
  const r = state.refs.objTransform;
  if (!entry || !r) return;
  const o = entry.object;
  const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
  r.px.value = round(o.position.x);
  r.py.value = round(o.position.y);
  r.pz.value = round(o.position.z);
  r.rx.value = round(THREE.MathUtils.radToDeg(e.x), 1);
  r.ry.value = round(THREE.MathUtils.radToDeg(e.y), 1);
  r.rz.value = round(THREE.MathUtils.radToDeg(e.z), 1);
  r.sx.value = round(o.scale.x);
  r.sy.value = round(o.scale.y);
  r.sz.value = round(o.scale.z);
}

function vec3Field(labelKey, get, set, opts = {}) {
  const r = {};
  const axis = (name, v) => {
    const inp = el('input', { type: 'number', step: opts.step ?? 0.05, value: v });
    inp.addEventListener('input', () => {
      const val = parseFloat(inp.value);
      if (Number.isFinite(val)) set(name, val);
    });
    r[name] = inp;
    return el('span', { class: 'vec3-cell' }, inp);
  };
  const v = get();
  const elm = el('label', { class: 'field' },
    el('div', { class: 'row' }, el('span', { class: 'field-label', 'data-loc': labelKey })),
    el('div', { class: 'vec3' }, axis('x', v.x), axis('y', v.y), axis('z', v.z)));
  return { elm, refs: r };
}

function renderObjectProps() {
  const host = state.refs.objProps;
  if (!host) return;
  host.innerHTML = '';
  state.refs.objTransform = null;
  const entry = stage.getSelected();
  if (!entry) {
    host.append(el('p', { class: 'hint', 'data-loc': 'objects.none' }));
    return;
  }
  const o = entry.object;

  const pos = vec3Field('objects.position',
    () => o.position,
    (a, v) => { o.position[a] = v; });
  const rot = vec3Field('objects.rotation',
    () => { const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ'); return { x: THREE.MathUtils.radToDeg(e.x), y: THREE.MathUtils.radToDeg(e.y), z: THREE.MathUtils.radToDeg(e.z) }; },
    (a, v) => { const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ'); e[a] = THREE.MathUtils.degToRad(v); o.rotation.set(e.x, e.y, e.z); },
    { step: 1 });
  const scl = vec3Field('objects.scale',
    () => o.scale,
    (a, v) => { o.scale[a] = v; });

  host.append(pos.elm, rot.elm, scl.elm);
  state.refs.objTransform = { px: pos.refs.x, py: pos.refs.y, pz: pos.refs.z, rx: rot.refs.x, ry: rot.refs.y, rz: rot.refs.z, sx: scl.refs.x, sy: scl.refs.y, sz: scl.refs.z };

  const btnRow = el('div', { class: 'btn-row' });
  const reset = el('button', { class: 'btn small', 'data-loc': 'objects.reset' });
  reset.addEventListener('click', () => { o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); syncTransformInputs(); });
  const center = el('button', { class: 'btn small', 'data-loc': 'objects.center' });
  center.addEventListener('click', () => { o.position.x = 0; o.position.z = 0; syncTransformInputs(); });
  const floor = el('button', { class: 'btn small', 'data-loc': 'objects.floor' });
  floor.addEventListener('click', () => { const b = new THREE.Box3().setFromObject(o); o.position.y -= b.min.y; syncTransformInputs(); });
  const focus = el('button', { class: 'btn small', 'data-loc': 'objects.focus' });
  focus.addEventListener('click', () => focusSelected());
  btnRow.append(reset, center, floor, focus);
  host.append(btnRow);

  if (!entry.builtin && !hasSkeleton(entry.object)) {
    const rigBtn = el('button', { class: 'btn wax wide', 'data-loc': 'objects.autorig' });
    rigBtn.addEventListener('click', () => autorigSelected());
    host.append(rigBtn);
    host.append(el('p', { class: 'hint', 'data-loc': 'objects.autorig.hint' }));
  }

  // animations
  host.append(section('objects.animations'));
  const clips = stage.clipsOf(entry.id);
  if (!clips.length) {
    host.append(el('p', { class: 'hint', 'data-loc': 'objects.noAnim' }));
  } else {
    const speedRow = el('label', { class: 'field' },
      el('div', { class: 'row' }, el('span', { class: 'field-label', 'data-loc': 'objects.animSpeed' }), el('output', {}, entry.speed.toFixed(2))));
    const speed = el('input', { type: 'range', min: 0.1, max: 3, step: 0.05, value: entry.speed });
    speed.addEventListener('input', () => {
      stage.setClipSpeed(entry.id, Number(speed.value));
      speedRow.querySelector('output').textContent = Number(speed.value).toFixed(2);
    });
    speedRow.append(speed);
    host.append(speedRow);
    const loop = toggleField('objects.animLoop', entry.loop, (v) => { entry.loop = v; stage.setClipLoop(entry.id, v); });
    host.append(loop);
    const list = el('div', { class: 'clip-list' });
    for (const clip of clips) {
      const playing = entry.clipName === clip.name && entry.playing;
      const row = el('div', { class: 'clip-row' + (playing ? ' playing' : '') });
      const btn = el('button', { class: 'btn small clip-play', title: state.i18n.t(playing ? 'objects.stop' : 'objects.play') }, playing ? '■' : '▶');
      btn.addEventListener('click', () => {
        if (playing) stage.stopClip(entry.id);
        else stage.playClip(entry.id, clip.name);
        renderObjectProps();
      });
      const addTl = el('button', { class: 'btn small clip-tl', title: state.i18n.t('objects.addToTimeline') }, '⏱');
      addTl.addEventListener('click', () => addClipToTimeline(entry, clip.name));
      row.append(btn, el('span', { class: 'clip-name' }, clip.name), addTl);
      list.append(row);
    }
    host.append(list);
  }
}

function focusSelected() {
  const entry = stage.getSelected();
  if (!entry) return;
  const box = new THREE.Box3().setFromObject(entry.object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  stage.orbit.target.copy(center);
  const dir = stage.freeCamera.position.clone().sub(center).normalize();
  stage.freeCamera.position.copy(center).add(dir.multiplyScalar(Math.max(1.5, size * 1.4)));
  stage.setFreecam(true);
  buildInspector();
  renderObjectList();
  renderObjectProps();
}

/* -------------------------------- importing ------------------------------- */

async function importModel() {
  const res = await api.importModel('model');
  if (res.canceled) return;
  try {
    const { object, animations } = await loadModelAsset(res);
    const entry = stage.addImported(res.name.replace(/\.[^.]+$/, ''), object, animations, { source: res.path });
    if (animations.length) toast(state.i18n.t('toast.importedAnim', { n: animations.length, name: entry.name }));
    else toast(state.i18n.t('toast.imported', { name: entry.name }));
    stage.selectObject(entry.id);
    setTab('objects');
    renderObjectList();
    renderObjectProps();
  } catch (err) {
    toast(state.i18n.t('toast.error', { msg: err.message }), 'error');
  }
}

async function importAnimation() {
  const res = await api.importModel('animation');
  if (res.canceled) return;
  try {
    const { object, animations } = await loadModelAsset(res);
    if (!animations.length) {
      toast(state.i18n.t('objects.noAnim'), 'error');
      return;
    }
    const target = stage.getSelected();
    if (target && hasSkeleton(target.object)) {
      const clips = retargetClips(animations, target.object);
      const added = stage.addClips(target.id, clips);
      target.retargetSources.push({ path: res.path, name: res.name });
      toast(state.i18n.t('toast.retargeted', { n: added, name: target.name }));
      renderObjectList();
      renderObjectProps();
      return;
    }
    const entry = stage.addImported(res.name.replace(/\.[^.]+$/, ''), object, animations, { source: res.path });
    stage.selectObject(entry.id);
    setTab('objects');
    toast(state.i18n.t('toast.importedAnim', { n: animations.length, name: entry.name }));
    renderObjectList();
    renderObjectProps();
  } catch (err) {
    toast(state.i18n.t('toast.error', { msg: err.message }), 'error');
  }
}

/** Active timeline animation clips at time t, as a renderer schedule. */
function buildAnimSchedule(t) {
  const track = state.timeline?.getTrack('anim');
  if (!track) return [];
  const out = [];
  for (const clip of track.clips) {
    if (t < clip.start || t >= clip.start + clip.duration) continue;
    const d = clip.data ?? {};
    if (!d.objectId || !d.clipName) continue;
    const speed = d.speed ?? 1;
    out.push({
      entryId: d.objectId,
      clipName: d.clipName,
      time: (t - clip.start) * speed,
      loop: d.loop ?? true,
      speed,
    });
  }
  return out;
}

function addClipToTimeline(entry, clipName) {
  const clip = stage.clipsOf(entry.id).find((c) => c.name === clipName);
  if (!clip) return;
  state.timeline.addClip('anim', {
    id: `anim_${entry.id}_${Date.now()}`,
    start: state.time,
    duration: Math.max(0.5, clip.duration || 2),
    label: `${entry.name} · ${clipName}`,
    kind: 'animation',
    data: { objectId: entry.id, clipName, loop: true, speed: 1 },
  });
  renderTimeline();
  toast(state.i18n.t('toast.animAdded', { name: clipName }));
}

function deleteObject(entry) {
  stage.removeImported(entry.id);
  const track = state.timeline?.getTrack('anim');
  if (track) track.clips = track.clips.filter((c) => c.data?.objectId !== entry.id);
  renderTimeline();
  renderObjectList();
  renderObjectProps();
}

async function autorigSelected() {
  const entry = stage.getSelected();
  if (!entry || entry.builtin) return;
  if (hasSkeleton(entry.object)) {
    toast(state.i18n.t('toast.autorigSkip'), 'error');
    return;
  }
  setStatus('status.rigging');
  await new Promise((r) => setTimeout(r, 30)); // let the busy state paint first
  try {
    const n = stage.autorigObject(entry.id);
    toast(state.i18n.t('toast.autorigged', { n }));
    renderObjectList();
    renderObjectProps();
  } catch (err) {
    toast(state.i18n.t('toast.error', { msg: err.message }), 'error');
  } finally {
    setStatus('status.ready');
  }
}

/* ------------------------------- persistence ------------------------------ */

/** Serialise the imported scene objects (engine-neutral paths + transforms). */
function collectAssets() {
  const assets = [];
  for (const entry of stage.objects) {
    if (entry.builtin) continue;
    const e = new THREE.Euler().setFromQuaternion(entry.object.quaternion, 'XYZ');
    assets.push({
      type: 'model',
      id: entry.id,
      name: entry.name,
      path: entry.source,
      position: [entry.object.position.x, entry.object.position.y, entry.object.position.z],
      rotation: [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)],
      scale: [entry.object.scale.x, entry.object.scale.y, entry.object.scale.z],
      visible: entry.object.visible,
      autoRigged: Boolean(entry.autoRigged),
    });
    for (const src of entry.retargetSources) {
      assets.push({ type: 'animation', targetId: entry.id, path: src.path, name: src.name });
    }
  }
  return assets;
}

/** Re-import persisted assets (best-effort: skip missing/broken files). */
async function restoreAssets(assets) {
  if (!Array.isArray(assets)) return;
  for (const a of assets) {
    if (!a || !a.path) continue;
    try {
      const res = await api.readModel(a.path);
      if (res.canceled || res.error) continue;
      if (a.type === 'animation') {
        const { object, animations } = await loadModelAsset(res);
        const target = stage.getImported(a.targetId);
        if (target && hasSkeleton(target.object) && animations.length) {
          stage.addClips(target.id, retargetClips(animations, target.object));
          target.retargetSources.push({ path: a.path, name: a.name });
        }
        continue;
      }
      const { object, animations } = await loadModelAsset(res);
      const entry = stage.addImported(a.name, object, animations, {
        source: a.path,
        id: a.id,
        position: a.position,
        rotation: a.rotation,
        scale: a.scale,
        visible: a.visible,
      });
      if (a.autoRigged) {
        try { stage.autorigObject(entry.id); } catch { /* ignore */ }
      }
    } catch { /* skip unreadable assets silently */ }
  }
}

function updateExportSummary() {
  const node = state.refs.exportSummary;
  if (!node || !canvas) return;
  node.textContent = `${canvas.width} × ${canvas.height} px · ${state.exportFps} fps`;
}

function buildInspector() {
  const host = $('#inspector');
  host.innerHTML = '';
  host.append(panelStage(), panelActor(), panelObjects(), panelCamera(), panelLight(), panelSound(), panelExport());
  state.i18n.apply(host);
  renderObjectList();
  renderObjectProps();
  updateExportSummary();
}

/* ------------------------------- timeline UI ------------------------------ */

function selectClip(track, clip) {
  state.selectedClip = clip.id;
  if (track.id === 'camera') setTab('camera');
  if (track.id === 'voice') setTab('sound');
  if (track.id === 'motion') setTab('actor');
  renderTimeline();
}

function renderTimeline() {
  const tl = state.timeline;
  const dur = tl.durationOf();
  const labels = $('#tlLabels');
  const tracks = $('#tracks');
  const ruler = $('#ruler');
  labels.innerHTML = '';
  tracks.innerHTML = '';
  ruler.innerHTML = '';

  for (const track of tl.tracks) {
    const labelKey = `timeline.track.${track.id}`;
    labels.append(el('div', { class: 'tl-label', 'data-kind': track.kind, 'data-loc': labelKey },
      state.i18n.t(labelKey)));
    const row = el('div', { class: 'track', 'data-track': track.id });
    for (const clip of track.clips) {
      const left = (clip.start / dur) * 100;
      const width = Math.max(0.8, (clip.duration / dur) * 100);
      const node = el('div', {
        class: 'clip' + (state.selectedClip === clip.id ? ' selected' : ''),
        'data-kind': clip.kind,
        style: `left:${left}%;width:${width}%`,
        title: `${clip.label || clip.id} · ${clip.duration.toFixed(2)}s`,
      }, clip.label || clip.id);
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        selectClip(track, clip);
      });
      row.append(node);
    }
    tracks.append(row);
  }

  const step = dur > 40 ? 10 : dur > 20 ? 5 : 2;
  for (let s = 0; s <= dur; s += step) {
    ruler.append(el('span', { class: 'tick', style: `left:${(s / dur) * 100}%` }, `${s}s`));
  }
  $('#tcTotal').textContent = tcText(dur);
  updatePlayhead();
}

function updatePlayhead() {
  const dur = state.timeline.durationOf();
  $('#playhead').style.left = `${(state.time / dur) * 100}%`;
}

/* -------------------------------- transport ------------------------------- */

async function seek(t) {
  const dur = state.timeline.durationOf();
  state.time = clamp(t, 0, dur);
  updatePlayhead();
  $('#tcCur').textContent = tcText(state.time);
  $('#scrub').value = String(Math.round((state.time / dur) * 1000));
  if (state.playing) {
    voice.stop();
    await scheduleFrom(state.time);
  }
}

async function scheduleFrom(from) {
  await voice.resume();
  const segments = collectSegments()
    .filter((s) => s.t + s.d > from)
    .map((s) => ({ ...s, t: Math.max(0, s.t - from) }));
  const start = voice.ctx.currentTime + 0.09;
  voice.schedule(segments, { startTime: start, rate: 1, pitch: state.project.voice.pitch });
  state.playStart = start;
  state.playFrom = from;
}

async function play() {
  const dur = state.timeline.durationOf();
  if (state.time >= dur - 0.02) state.time = 0;
  await scheduleFrom(state.time);
  state.playing = true;
  setTransportState();
  setStatus('status.playing');
}

function pause() {
  voice.stop();
  state.playing = false;
  setTransportState();
  setStatus('status.ready');
}

function stop() {
  pause();
  state.time = 0;
  updatePlayhead();
  $('#tcCur').textContent = tcText(0);
  $('#scrub').value = '0';
}

function setTransportState() {
  const btn = $('#btnPlay');
  btn.textContent = state.playing ? '❚❚' : '▶';
  btn.title = state.i18n.t(state.playing ? 'transport.pause' : 'transport.play');
}

function setStatus(key) {
  $('#statusText').textContent = state.i18n.t(key);
}

/* --------------------------------- actions -------------------------------- */

function addCut(type = 'fade') {
  const tl = state.timeline;
  const t = state.time;
  const camTrack = tl.getTrack('camera');
  const current = tl.cameraAt(t - 0.001).to;
  const next = current === 'A' ? 'B' : 'A';
  // trim the clip that is being cut
  for (const c of camTrack.clips) {
    if (t > c.start && t < c.start + c.duration) c.duration = +(t - c.start).toFixed(3);
  }
  tl.addClip('camera', {
    id: `cam_${next}_${Date.now()}`,
    start: t,
    duration: Math.max(1, tl.durationOf() - t),
    label: `${next} · ${type}`,
    data: { cam: next, in: { type, duration: type === 'cut' ? 0 : 0.6, easing: 'easeInOut' } },
  });
  renderTimeline();
  toast(state.i18n.t('toast.cut', { t: tcText(t) }));
}

async function rebuildVoice() {
  const clip = voiceClip();
  if (!clip) return;
  refreshVoiceClip(clip, state.project.localization.locale, state.project.voice.rate);
  rebuildPipeline();
  renderTimeline();
  buildInspector();
  await seek(state.time);
  if (state.refs.soundMetrics) {
    state.refs.soundMetrics.textContent = state.i18n.t('sound.metrics', {
      n: clip.data.visemes.length, s: clip.duration.toFixed(2),
    });
  }
  toast(state.i18n.t('toast.voice', { n: clip.data.visemes.length, s: clip.duration.toFixed(2) }));
}

async function setMic(on) {
  if (on) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await voice.resume();
      const src = voice.ctx.createMediaStreamSource(stream);
      const analyser = voice.ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      Object.assign(state.mic, { on: true, stream, src, analyser });
    } catch (err) {
      state.mic.on = false;
      toast(state.i18n.t('toast.micDenied'), 'error');
      buildInspector();
    }
  } else {
    state.mic.stream?.getTracks().forEach((t) => t.stop());
    try { state.mic.src?.disconnect(); } catch { /* ignore */ }
    Object.assign(state.mic, { on: false, stream: null, src: null, analyser: null, level: 0 });
  }
}

function micLevel() {
  if (!state.mic.analyser) return 0;
  const buf = new Float32Array(state.mic.analyser.fftSize);
  state.mic.analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 7);
}

async function startRecording() {
  try {
    await voice.resume();
    state.recorder = new CanvasRecorder(canvas, voice.stream, { fps: state.exportFps });
    state.recorder.start();
    state.recording = true;
    state.refs.recBtn.textContent = state.i18n.t('export.stop');
    $('#recBadge').classList.remove('hidden');
    setStatus('status.recording');
    await seek(0);
    await play();
  } catch (err) {
    toast(state.i18n.t('toast.error', { msg: err.message }), 'error');
  }
}

async function stopRecording() {
  if (!state.recorder) return;
  const blob = await state.recorder.stop();
  state.recorder = null;
  state.recording = false;
  state.refs.recBtn.textContent = state.i18n.t('export.record');
  $('#recBadge').classList.add('hidden');
  pause();
  setStatus('status.ready');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const res = await api.saveBinary(buf, `oliteatry-${Date.now()}.webm`, [
    { name: 'WebM', extensions: ['webm'] },
  ]);
  if (!res.canceled) toast(state.i18n.t('toast.exported', { path: res.path }));
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] ?? '';
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function exportStill() {
  const url = stage.grabFrame();
  const res = await api.saveBinary(dataUrlToBytes(url), `oliteatry-quadro-${Date.now()}.png`, [
    { name: 'PNG', extensions: ['png'] },
  ]);
  if (!res.canceled) toast(state.i18n.t('toast.still', { path: res.path }));
}

function captureStill() {
  const url = stage.grabFrame();
  state.stopMotion.frames.push(url);
  updateOnion();
  if (state.refs.framesLabel) {
    state.refs.framesLabel.textContent = state.i18n.t('export.frames', { n: state.stopMotion.frames.length });
  }
  toast(state.i18n.t('toast.captured', { n: state.stopMotion.frames.length }));
}

function updateOnion() {
  const layer = $('#onionLayer');
  const img = $('#onionImg');
  const last = state.stopMotion.frames[state.stopMotion.frames.length - 1];
  if (state.stopMotion.onion && last) {
    img.src = last;
    layer.classList.remove('hidden');
  } else {
    layer.classList.add('hidden');
  }
  if (state.refs.framesLabel) {
    state.refs.framesLabel.textContent = state.i18n.t('export.frames', { n: state.stopMotion.frames.length });
  }
}

async function exportStopMotion() {
  if (!state.stopMotion.frames.length) return;
  setStatus('status.recording');
  state.exporting = true;
  let blob;
  try {
    blob = await encodeStills(canvas, state.stopMotion.frames, { fps: 12 });
  } finally {
    state.exporting = false;
  }
  setStatus('status.ready');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const res = await api.saveBinary(buf, `oliteatry-stopmotion-${Date.now()}.webm`, [
    { name: 'WebM', extensions: ['webm'] },
  ]);
  if (!res.canceled) toast(state.i18n.t('toast.exported', { path: res.path }));
}

async function exportSrt() {
  const clip = voiceClip();
  if (!clip) return;
  const words = clip.data.words ?? [];
  const cues = wordsToCues(words, { offset: clip.start });
  const res = await api.saveText(cuesToSrt(cues), `oliteatry-${Date.now()}.srt`);
  if (!res.canceled) toast(state.i18n.t('toast.saved', { path: res.path }));
}

async function saveProject() {
  state.project.timeline.tracks = state.timeline.tracks;
  state.project.timeline.duration = state.timeline.duration;
  state.project.meta.name = $('#projectName').value || 'Palco sem nome';
  state.project.assets = collectAssets();
  const res = await api.saveProject(projectToJSON(state.project), slug(state.project.meta.name) + '.oliteproj.json');
  if (!res.canceled) toast(state.i18n.t('toast.saved', { path: res.path }));
}

async function openProject() {
  const res = await api.openProject();
  if (res.canceled) return;
  try {
    await loadProject(projectFromJSON(res.content));
    toast(state.i18n.t('toast.opened'));
  } catch (err) {
    toast(state.i18n.t('toast.error', { msg: err.message }), 'error');
  }
}

function slug(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'oliteatry';
}

async function newProject() {
  await loadProject(createProject());
  toast(state.i18n.t('top.new'));
}

async function loadProject(project) {
  state.project = project;
  state.timeline = timelineFromProject(project);
  state.selectedClip = null;
  $('#projectName').value = project.meta?.name ?? 'Palco sem nome';
  stage.applyStage(project.stage);
  stage.applyLighting(project.lighting);
  stage.setCameras(project.cameras);
  stage.setPostParams(project.post);
  stage.clearImported();
  await restoreAssets(project.assets);
  rebuildPipeline();
  buildInspector();
  renderTimeline();
  seek(0);
}

/* -------------------------------- frame loop ------------------------------ */

let lastFrame = performance.now();
let fpsWindow = 0;
let fpsCount = 0;
let hudClock = 0;

function tick(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  state.frames += 1;

  fpsWindow += dt;
  fpsCount += 1;
  if (fpsWindow > 0.4) {
    state.fps = fpsCount / fpsWindow;
    fpsWindow = 0;
    fpsCount = 0;
  }

  if (state.playing) {
    const dur = state.timeline.durationOf();
    const t = state.playFrom + (voice.ctx.currentTime - state.playStart);
    state.time = clamp(t, 0, dur);
    if (t >= dur) {
      if (state.loop) {
        state.time = 0;
        scheduleFrom(0);
      } else {
        pause();
        state.time = dur;
      }
    }
  }

  if (state.mic.on) state.mic.level = micLevel();

  const sample = state.pipeline.sample(state.time);
  const live = state.project.performance.liveMic ? state.mic.level : 0;
  stage.applyPerformance(sample, { liveMic: live, mirrorTime: state.time });
  stage.updateDust(state.time);
  stage.update(dt);
  stage.syncTimelineAnimations(buildAnimSchedule(state.time));

  const decision = state.timeline.cameraAt(state.time);
  if (!state.exporting) stage.render(state.time, decision);

  if (state.playing) {
    updatePlayhead();
    const dur = state.timeline.durationOf();
    $('#scrub').value = String(Math.round((state.time / dur) * 1000));
    $('#tcCur').textContent = tcText(state.time);
  }

  hudClock += dt;
  if (hudClock > 0.12) {
    hudClock = 0;
    const badge = $('#camBadge');
    badge.textContent = decision.progress < 1 && decision.to !== decision.from
      ? `${decision.from} → ${decision.to}`
      : `CAM ${decision.to}`;
    $('#tcHud').textContent = timecodeHud(state.time, state.timeline.fps);
    $('#fpsHud').textContent = `${Math.round(state.fps)} fps`;
    if (state.refs.actorState) {
      state.refs.actorState.textContent = sample.meta.state;
      state.refs.actorViseme.textContent = sample.meta.viseme;
      state.refs.actorGesture.textContent = sample.meta.gesture ?? '—';
      state.refs.actorGesture.className = sample.meta.gesture ? 'accent' : '';
    }
  }

  if (!window.__oliteatry.ready && state.frames > 4) window.__oliteatry.ready = true;
  requestAnimationFrame(tick);
}

/* ---------------------------------- sizing -------------------------------- */

function applySize() {
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  stage.setSize(rect.width, rect.height, window.devicePixelRatio * state.exportScale);
  updateExportSummary();
}

/* ----------------------------------- tabs --------------------------------- */

function setTab(id) {
  state.activeTab = id;
  for (const btn of document.querySelectorAll('.rail-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === id);
  }
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.dataset.panel === id);
  }
}

function buildRail() {
  const rail = $('#rail');
  rail.innerHTML = '';
  for (const tab of TABS) {
    const btn = el('button', { class: 'rail-btn' + (state.activeTab === tab.id ? ' active' : ''), 'data-tab': tab.id, 'data-loc-title': `tabs.${tab.id}` });
    btn.innerHTML = ICONS[tab.icon];
    btn.append(el('span', { 'data-loc': `tabs.${tab.id}` }, state.i18n.t(`tabs.${tab.id}`)));
    btn.addEventListener('click', () => setTab(tab.id));
    rail.append(btn);
  }
}

/* ---------------------------------- wiring -------------------------------- */

function wireChrome() {
  $('#btnMin').addEventListener('click', () => api.minimize());
  $('#btnMax').addEventListener('click', () => api.maximize());
  $('#btnClose').addEventListener('click', () => api.close());
  $('#btnNew').addEventListener('click', () => newProject());
  $('#btnOpen').addEventListener('click', () => openProject());
  $('#btnSave').addEventListener('click', () => saveProject());
  $('#btnPlay').addEventListener('click', () => (state.playing ? pause() : play()));
  $('#btnStop').addEventListener('click', () => stop());
  $('#loopChk').addEventListener('change', (e) => { state.loop = e.target.checked; });

  const scrub = $('#scrub');
  scrub.addEventListener('input', () => {
    const dur = state.timeline.durationOf();
    seek((Number(scrub.value) / 1000) * dur);
  });

  let dragging = false;
  const scrubFromEvent = (e) => {
    const rect = $('#tlGrid').getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    seek(ratio * state.timeline.durationOf());
  };
  const ruler = $('#ruler');
  ruler.addEventListener('pointerdown', (e) => {
    dragging = true;
    ruler.setPointerCapture(e.pointerId);
    scrubFromEvent(e);
  });
  ruler.addEventListener('pointermove', (e) => { if (dragging) scrubFromEvent(e); });
  ruler.addEventListener('pointerup', (e) => {
    dragging = false;
    try { ruler.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  $('#projectName').addEventListener('input', (e) => {
    state.project.meta.name = e.target.value;
  });

  window.addEventListener('keydown', async (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
    if (e.code === 'ArrowRight') { e.preventDefault(); seek(state.time + (e.shiftKey ? 1 : 1 / state.timeline.fps)); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); seek(state.time - (e.shiftKey ? 1 : 1 / state.timeline.fps)); }
    if (e.code === 'KeyC') { addCut(state.project.cameraTransition ?? 'fade'); }
    if (e.code === 'KeyS' && e.ctrlKey) { e.preventDefault(); saveProject(); }
    if (e.code === 'KeyO' && e.ctrlKey) { e.preventDefault(); openProject(); }
    // scene-object manipulation
    if (e.code === 'KeyW') { setGizmoMode('translate'); }
    if (e.code === 'KeyE') { setGizmoMode('rotate'); }
    if (e.code === 'KeyR') { setGizmoMode('scale'); }
    if (e.code === 'KeyG') { stage.setFreecam(!stage.freecam); buildInspector(); }
    if (e.code === 'KeyF') { focusSelected(); }
    if (e.code === 'Escape') { stage.deselect(); renderObjectList(); renderObjectProps(); }
    if (e.code === 'Delete' || e.code === 'Backspace') {
      const sel = stage.getSelected();
      if (sel && !sel.builtin) deleteObject(sel);
    }
  });

  // click-to-select in the viewport
  canvas.addEventListener('click', (e) => {
    const entry = stage.pickImported(e.clientX, e.clientY);
    if (entry) stage.selectObject(entry.id);
    else stage.deselect();
    renderObjectList();
    renderObjectProps();
  });

  new ResizeObserver(() => applySize()).observe($('#viewport'));
  window.addEventListener('resize', () => applySize());
}

/* ----------------------------------- boot --------------------------------- */

async function boot() {
  window.__oliteatry = {
    ready: false,
    report: () => ({
      ok: state.errors.length === 0 && state.frames > 5,
      frames: state.frames,
      fps: Math.round(state.fps),
      time: +state.time.toFixed(2),
      webgl: stage?.renderer?.capabilities?.isWebGL2 ? 2 : 1,
      renderer: (() => {
        try {
          const gl = stage.renderer.getContext();
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        } catch { return 'unknown'; }
      })(),
      canvas: canvas ? [canvas.width, canvas.height] : [0, 0],
      clips: state.timeline ? state.timeline.tracks.reduce((n, t) => n + t.clips.length, 0) : 0,
      objects: stage.objects.length,
      selected: stage.selectedId,
      freecam: stage.freecam,
      syllables: collectSegments().length,
      locale: state.i18n?.locale,
      sample: state.pipeline ? state.pipeline.sample(state.time).meta : null,
      mime: CanvasRecorder.pickMime(),
      errors: state.errors,
    }),
    seek: (t) => seek(t),
    setTab: (id) => setTab(id),
    setLocale: (code) => {
      state.i18n.setLocale(code);
      state.i18n.apply(document);
      buildRail();
      renderTimeline();
      buildInspector();
    },
  };

  window.addEventListener('error', (e) => state.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason)));

  state.i18n = await I18n.load({
    'pt-BR': '../locales/pt-BR.json',
    en: '../locales/en.json',
  }, { locale: 'pt-BR', fallback: 'en' });
  state.i18n.apply(document);

  const langSel = $('#langSel');
  langSel.append(el('option', { value: 'pt-BR' }, 'Português (BR)'));
  langSel.append(el('option', { value: 'en' }, 'English'));
  langSel.value = state.i18n.locale;
  langSel.addEventListener('change', () => {
    state.i18n.setLocale(langSel.value);
    state.i18n.apply(document);
    buildRail();
    renderTimeline();
    buildInspector();
    setTransportState();
  });

  canvas = $('#view');
  viewport = $('#viewport');
  stage = new Stage(canvas);
  stage.onFreecamChange = syncFreecamToggle;
  stage.transformControls.addEventListener('objectChange', () => syncTransformInputs());
  voice = new VoiceEngine();
  await voice.resume();

  $('#gpuBadge').textContent = stage.renderer.capabilities.isWebGL2 ? 'WEBGL2' : 'WEBGL1';

  buildRail();
  await loadProject(createProject());
  wireChrome();
  applySize();
  setTransportState();
  requestAnimationFrame(tick);
}

boot().catch((err) => {
  window.__bootError = String(err?.stack ?? err);
  // eslint-disable-next-line no-console
  console.error('boot failed', err);
  document.body.append(el('pre', { style: 'position:fixed;inset:20px;background:#fff;color:#900;padding:20px;z-index:999;white-space:pre-wrap' }, String(err?.stack ?? err)));
  window.__oliteatry = { ready: false, report: () => ({ ok: false, error: String(err?.stack ?? err) }) };
});
