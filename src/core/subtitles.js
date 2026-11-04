/** Subtitles from the same word timings that drive lip-sync. */

export function wordsToCues(words = [], {
  maxChars = 42,
  maxCps = 17,
  minDur = 1.0,
  maxDur = 7,
  gap = 0.55,
  offset = 0,
} = {}) {
  const cues = [];
  let cur = null;

  const push = () => {
    if (!cur || !cur.words.length) return;
    const text = cur.words.join(' ');
    const dur = Math.max(minDur, text.length / maxCps, cur.end - cur.start);
    cues.push({
      start: +cur.start.toFixed(3),
      end: +(cur.start + Math.min(dur, Math.max(maxDur, minDur))).toFixed(3),
      text,
    });
    cur = null;
  };

  for (const w of words) {
    const start = w.t + offset;
    const end = w.end + offset;
    if (!cur) {
      cur = { start, end, words: [w.text] };
      continue;
    }
    const candidate = [...cur.words, w.text].join(' ');
    const tooLong = candidate.length > maxChars;
    const tooFar = start - cur.end > gap;
    const tooSlow = start + Math.max(minDur, candidate.length / maxCps) > cur.start + maxDur;
    if (tooLong || tooFar || tooSlow) {
      push();
      cur = { start, end, words: [w.text] };
    } else {
      cur.words.push(w.text);
      cur.end = end;
    }
  }
  push();
  return cues;
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function srtTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

export function cuesToSrt(cues = []) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function buildSrt(words, opts = {}) {
  return cuesToSrt(wordsToCues(words, opts));
}
