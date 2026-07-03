// gen-detection-fixtures.mjs — regenerate the committed detection fixtures
// (issue #24). Run with `node scripts/gen-detection-fixtures.mjs`.
//
// These are SYNTHETIC SEED clips, not real recordings: this repo's tuning is done
// live with the child and no mic is available at authoring time. Each clip is a
// deterministic (LCG, no Math.random) stand-in for one coarse class, sized so its
// replay through the REAL detector stack (tests/detection-fixtures.test.ts) reads
// as the intended outcome — locking the harness + detectors against a known-good
// signal. Drop REAL captured clips (downloaded from the #22 test screen's «запись»
// control) alongside these under tests/fixtures/ and the same test scores them.
//
// The synthesis is intentionally simple (a tone for a vowel, LCG noise for a hiss,
// a tone→gap→transient for a кот «т»); the detectors are the real thing on replay.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SR = 44100;
const FFT = 256; // small buffers keep the committed JSON compact
const BINS = 128;
const DT = 16; // ~60 fps
const HZ_PER_BIN = SR / 2 / BINS;

// A canonical adult-«а» calibration baseline (≈ VOWEL_FORMANTS.а), embedded in
// every vowel-bearing seed so classifyVowel replays in a fixed formant space.
const BASELINE = { centroid: 900, f1: 700, f2: 1300 };

// ---- deterministic signal generators (mirror tests/_helpers.ts) ----

function sineTime(freq, amp, n = FFT) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

function noiseTime(amp, n = FFT, seed = 1) {
  let s = seed >>> 0;
  const a = new Array(n);
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    a[i] = (s / 0xffffffff) * 2 * amp - amp;
  }
  return a;
}

function silentTime(n = FFT, amp = 0.0004, seed = 7) {
  // A whisper of ambient so "silence" isn't a mathematically perfect zero.
  return noiseTime(amp, n, seed);
}

// A COMPACT silent frame: a handful of near-zero samples, zero-padded to fftSize
// by the ClipAnalyser on replay, and no spectrum (defaults to silent). Keeps the
// long trailing tails a real attempt needs to CLOSE (the smoothed-RMS release is
// ~120 ms-slow) from bloating the committed JSON.
function silentFrame(seed = 7) {
  return { dtMs: DT, time: noiseTime(0.0004, 8, seed).map(rt) };
}

// ---- dB magnitude spectra (AnalyserNode convention) ----

function vowelSpectrumDb(f1Hz, f2Hz, n = BINS) {
  const b1 = f1Hz / HZ_PER_BIN;
  const b2 = f2Hz / HZ_PER_BIN;
  const sigma = 2.2;
  const a = new Array(n);
  for (let i = 0; i < n; i++) {
    const lin =
      1.0 * Math.exp(-((i - b1) ** 2) / (2 * sigma ** 2)) +
      0.8 * Math.exp(-((i - b2) ** 2) / (2 * sigma ** 2)) +
      1e-5;
    a[i] = 20 * Math.log10(lin);
  }
  return a;
}

function flatSpectrumDb(db, n = BINS) {
  return new Array(n).fill(db);
}

function silentSpectrumDb(n = BINS) {
  return new Array(n).fill(-140);
}

// ---- rounding to keep the JSON small ----

const rt = (x) => Math.round(x * 1e4) / 1e4; // time samples
const rd = (x) => Math.round(x * 10) / 10; // dB

function frame(time, freq, dtMs = DT) {
  return { dtMs, time: time.map(rt), freq: freq.map(rd) };
}

function repeat(n, make) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(make(i));
  return out;
}

// ---- the four coarse-class seed clips ----

// One held vowel: a steady child-pitch tone (f0 decoupled from identity — a
// vowel is its FORMANTS, carried by the spectrum, not its pitch) with the vowel's
// formant spectrum → low ZCR, dark, low-heavy.
function bareVowelClip(label, f1, f2) {
  const tone = sineTime(300, 0.22);
  const spec = vowelSpectrumDb(f1, f2);
  return {
    version: 1,
    label,
    sampleRate: SR,
    fftSize: FFT,
    binCount: BINS,
    assist: 0.5,
    baseline: BASELINE,
    note: "synthetic seed (issue #24) — replace with a real capture when available",
    frames: [
      ...repeat(12, () => frame(tone, spec)),
      // A tail long enough for the smoothed-RMS release + 250 ms accumulator tail,
      // so the on-screen scorer closes exactly one attempt.
      ...repeat(34, (i) => silentFrame(20 + i)),
    ],
  };
}

// A sustained voiceless hiss: broadband noise with a bright, flat spectrum.
function hissClip() {
  return {
    version: 1,
    label: "hiss",
    sampleRate: SR,
    fftSize: FFT,
    binCount: BINS,
    assist: 0.5,
    baseline: BASELINE,
    note: "synthetic seed (issue #24) — replace with a real capture when available",
    frames: [
      ...repeat(14, (i) => frame(noiseTime(0.16, FFT, 101 + i), flatSpectrumDb(-24))),
      ...repeat(8, (i) => silentFrame(40 + i)),
    ],
  };
}

// Ambient room: no attempt.
function silenceClip() {
  return {
    version: 1,
    label: "silence",
    sampleRate: SR,
    fftSize: FFT,
    binCount: BINS,
    assist: 0.5,
    baseline: null,
    note: "synthetic seed (issue #24) — replace with a real capture when available",
    frames: repeat(18, (i) => silentFrame(3 + i)),
  };
}

// кот: a held «о» → a brief near-silent closure → a broadband «т» release
// transient → trailing silence long enough for the attempt to close.
function kotClip() {
  const vowel = sineTime(300, 0.22);
  const vowelSpec = vowelSpectrumDb(500, 900); // «о»
  const burst = noiseTime(0.3, FFT, 55);
  return {
    version: 1,
    label: "kot",
    sampleRate: SR,
    fftSize: FFT,
    binCount: BINS,
    assist: 0.5,
    baseline: BASELINE,
    note: "synthetic seed (issue #24) — replace with a real capture when available",
    frames: [
      ...repeat(12, () => frame(vowel, vowelSpec)), // held vowel
      ...repeat(6, (i) => silentFrame(60 + i)), // ~96 ms closure
      frame(burst, flatSpectrumDb(-22)), // «т» burst transient
      frame(burst, flatSpectrumDb(-26)),
      ...repeat(34, (i) => silentFrame(70 + i)), // trailing silence — let it close
    ],
  };
}

const clips = {
  "bare-a": bareVowelClip("bare-a", 700, 1300),
  "bare-o": bareVowelClip("bare-o", 500, 900),
  "bare-u": bareVowelClip("bare-u", 320, 700),
  "bare-i": bareVowelClip("bare-i", 300, 2200),
  hiss: hissClip(),
  silence: silenceClip(),
  kot: kotClip(),
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
mkdirSync(outDir, { recursive: true });
for (const [name, clip] of Object.entries(clips)) {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(clip) + "\n");
  console.log(`wrote tests/fixtures/${name}.json (${clip.frames.length} frames)`);
}
