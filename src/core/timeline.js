/**
 * Timeline model: pure data, no rendering. A project is a list of tracks; a
 * track is a sorted list of clips. Sampling is a pure function of time, which
 * keeps scrubbing, playback and offline rendering identical.
 */
import { clamp } from './prng.js';

export const DEFAULT_FPS = 60;

export const timeToFrame = (t, fps) => Math.round(t * fps);
export const frameToTime = (f, fps) => f / fps;

export function trackTemplate() {
  return [
    { id: 'camera', kind: 'camera', label: 'Câmera', clips: [] },
    { id: 'voice', kind: 'speech', label: 'Voz', clips: [] },
    { id: 'motion', kind: 'motion', label: 'Movimento', clips: [] },
    { id: 'anim', kind: 'animation', label: 'Animação', clips: [] },
    { id: 'sfx', kind: 'sfx', label: 'SFX', clips: [] },
  ];
}

export class Timeline {
  constructor({ duration = 24, fps = DEFAULT_FPS, tracks = trackTemplate() } = {}) {
    this.duration = duration;
    this.fps = fps;
    this.tracks = tracks;
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id);
  }

  addTrack(track) {
    this.tracks.push(track);
    return track;
  }

  addClip(trackId, clip) {
    const track = this.getTrack(trackId);
    if (!track) throw new Error(`unknown track: ${trackId}`);
    const next = {
      id: clip.id ?? `clip_${trackId}_${track.clips.length + 1}`,
      kind: clip.kind ?? track.kind,
      start: Math.max(0, clip.start ?? 0),
      duration: Math.max(0.05, clip.duration ?? 1),
      label: clip.label ?? '',
      data: clip.data ?? {},
    };
    track.clips.push(next);
    track.clips.sort((a, b) => a.start - b.start);
    return next;
  }

  removeClip(trackId, clipId) {
    const track = this.getTrack(trackId);
    if (!track) return false;
    const before = track.clips.length;
    track.clips = track.clips.filter((c) => c.id !== clipId);
    return track.clips.length !== before;
  }

  clearTrack(trackId) {
    const track = this.getTrack(trackId);
    if (track) track.clips = [];
  }

  clipsAt(trackId, t) {
    const track = this.getTrack(trackId);
    if (!track) return [];
    return track.clips.filter((c) => t >= c.start && t < c.start + c.duration);
  }

  clipAt(trackId, t) {
    return this.clipsAt(trackId, t)[0] ?? null;
  }

  /** Latest clip that has already started on a track (for camera holds). */
  activeClip(trackId, t) {
    const track = this.getTrack(trackId);
    if (!track || !track.clips.length) return null;
    let found = track.clips[0];
    for (const c of track.clips) {
      if (c.start <= t + 1e-6) found = c;
      else break;
    }
    return found;
  }

  /**
   * Camera decision at time t.
   * -> { from, to, progress, type, easing }
   * progress 1 means "fully on `to`".
   */
  cameraAt(t) {
    const track = this.getTrack('camera');
    if (!track || !track.clips.length) {
      return { from: 'A', to: 'A', progress: 1, type: 'cut', easing: 'linear' };
    }
    const clips = track.clips;
    let idx = -1;
    for (let i = 0; i < clips.length; i++) {
      if (clips[i].start <= t + 1e-6) idx = i;
      else break;
    }
    if (idx < 0) idx = 0;
    const cur = clips[idx];
    const prev = idx > 0 ? clips[idx - 1] : null;
    const curCam = cur.data?.cam ?? 'A';
    const prevCam = prev?.data?.cam ?? curCam;
    const inside = cur.data?.in;
    if (prev && inside && inside.type && inside.type !== 'cut') {
      const dur = Math.max(0.001, inside.duration ?? 0.5);
      const p = clamp((t - cur.start) / dur, 0, 1);
      if (p < 1) {
        return { from: prevCam, to: curCam, progress: p, type: inside.type, easing: inside.easing ?? 'easeInOut' };
      }
    }
    return { from: curCam, to: curCam, progress: 1, type: 'cut', easing: 'linear' };
  }

  /** Longest clip end, used to bound exports. */
  contentEnd() {
    let end = 0;
    for (const tr of this.tracks) {
      for (const c of tr.clips) end = Math.max(end, c.start + c.duration);
    }
    return end;
  }

  durationOf() {
    return Math.max(this.duration, this.contentEnd());
  }
}

export function easingFn(name) {
  switch (name) {
    case 'easeIn':
      return (t) => t * t;
    case 'easeOut':
      return (t) => 1 - (1 - t) * (1 - t);
    case 'easeInOut':
      return (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    default:
      return (t) => t;
  }
}
