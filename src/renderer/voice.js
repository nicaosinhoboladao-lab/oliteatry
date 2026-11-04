/**
 * Audio: a local "scratch" formant synthesiser that turns the same viseme
 * segments used for lip-sync into audible babble. It exists so the studio is
 * fully functional offline, with no API key — the ElevenLabs adapter
 * implements the same schedule() contract and swaps in later.
 */

const FORMANTS = {
  aa: [780, 1180], E: [500, 1820], I: [330, 2280], O: [500, 900], U: [340, 760],
  nn: [300, 1400], DD: [350, 1650], kk: [420, 1500], RR: [420, 1180],
  PP: [300, 900], FF: [420, 1500], TH: [400, 1600], CH: [480, 1800], SS: [520, 2200],
  sil: [400, 1000],
};

const NOISY = new Set(['FF', 'TH', 'SS', 'CH', 'PP', 'kk', 'DD']);

function noiseBuffer(ctx, seconds = 0.5) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return buf;
}

export class VoiceEngine {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.streamDest = this.ctx.createMediaStreamDestination();

    this.master.connect(this.ctx.destination);
    this.master.connect(this.analyser);
    this.master.connect(this.streamDest);

    this._noise = noiseBuffer(this.ctx);
    this._live = [];
  }

  get stream() {
    return this.streamDest.stream;
  }

  get currentTime() {
    return this.ctx.currentTime;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx.state === 'running';
  }

  /** Level of the scratch voice (0..1), for the HUD meter. */
  level() {
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.min(1, Math.sqrt(sum / buf.length) * 6);
  }

  /**
   * Schedule every viseme segment as a formant burst.
   * @param {Array<{t:number,d:number,viseme:string,weight:number}>} segments
   */
  schedule(segments, { startTime, rate = 1, pitch = 1, gain = 1 } = {}) {
    const ctx = this.ctx;
    const t0Base = startTime ?? ctx.currentTime + 0.06;
    this.stop();

    for (const seg of segments) {
      if (!seg || seg.viseme === 'sil') continue;
      const t0 = t0Base + seg.t;
      const dur = Math.max(0.05, (seg.d / Math.max(0.5, rate)) * 0.94);
      const f = FORMANTS[seg.viseme] ?? FORMANTS.aa;

      const env = ctx.createGain();
      const peak = Math.min(0.22, 0.11 * (0.6 + seg.weight) * gain);
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + 0.016);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      env.connect(this.master);

      const base = 116 * pitch;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 1.02, t0);
      osc.frequency.linearRampToValueAtTime(base * 0.94, t0 + dur);

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 4.4 + (seg.weight || 0.5) * 1.2;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = base * 0.018;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      const bp1 = ctx.createBiquadFilter();
      bp1.type = 'bandpass';
      bp1.frequency.value = f[0];
      bp1.Q.value = 5.5;
      const bp2 = ctx.createBiquadFilter();
      bp2.type = 'bandpass';
      bp2.frequency.value = f[1];
      bp2.Q.value = 7.5;
      const mix = ctx.createGain();
      mix.gain.value = 1.15;

      osc.connect(bp1);
      osc.connect(bp2);
      bp1.connect(mix);
      bp2.connect(mix);
      mix.connect(env);

      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.03);
      this._live.push(osc, lfo);

      if (NOISY.has(seg.viseme)) {
        const src = ctx.createBufferSource();
        src.buffer = this._noise;
        const hp = ctx.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.value = seg.viseme === 'SS' ? 4200 : seg.viseme === 'FF' ? 2600 : 1900;
        hp.Q.value = 1.2;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.exponentialRampToValueAtTime(0.035 * gain, t0 + 0.008);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.min(dur, 0.1));
        src.connect(hp);
        hp.connect(ng);
        ng.connect(this.master);
        src.start(t0);
        src.stop(t0 + Math.min(dur, 0.12));
        this._live.push(src);
      }
    }
    return t0Base;
  }

  /** Play a single UI confirmation blip. */
  blip(freq = 660, dur = 0.09) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  stop() {
    for (const node of this._live) {
      try {
        node.stop(0);
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this._live = [];
  }
}

/** Records the canvas + the studio audio into a single WebM. */
export class CanvasRecorder {
  constructor(canvas, audioStream, { fps = 60, bitsPerSecond = 14_000_000 } = {}) {
    this.canvas = canvas;
    this.audioStream = audioStream;
    this.fps = fps;
    this.bitsPerSecond = bitsPerSecond;
    this.chunks = [];
    this.rec = null;
  }

  static pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
  }

  start() {
    const mimeType = CanvasRecorder.pickMime();
    if (!mimeType) throw new Error('MediaRecorder/WebM unavailable');
    this.stream = this.canvas.captureStream(this.fps);
    if (this.audioStream) {
      for (const track of this.audioStream.getAudioTracks()) this.stream.addTrack(track);
    }
    this.videoTracks = this.stream.getVideoTracks();
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: this.bitsPerSecond });
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
    return mimeType;
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec) return reject(new Error('not recording'));
      this.rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'video/webm' });
        for (const t of this.videoTracks ?? []) t.stop();
        this.rec = null;
        resolve(blob);
      };
      this.rec.stop();
    });
  }
}

/** Encode captured stills into a WebM by replaying them at `fps`. */
export async function encodeStills(canvas, dataUrls, { fps = 12, mimeType } = {}) {
  const ctx2d = canvas.getContext('2d');
  const mime = mimeType ?? CanvasRecorder.pickMime() ?? 'video/webm';
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = () => res(new Blob(chunks, { type: mime }))));
  rec.start(100);
  for (const url of dataUrls) {
    const img = new Image();
    img.src = url;
    await img.decode();
    ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  await new Promise((r) => setTimeout(r, 180));
  rec.stop();
  for (const t of stream.getVideoTracks()) t.stop();
  return done;
}
