/**
 * Shared test fixtures: a full-frame factory, deterministic signal generators,
 * and a fake AnalyserNode that replays canned buffers. No randomness (so runs
 * are reproducible) and no browser APIs.
 */
import type { AudioFrame, SpectralAnalyserLike } from "../src/audio/AudioEngine";

/** A complete AudioFrame with quiet defaults; override only what a test cares about. */
export function makeFrame(p: Partial<AudioFrame> = {}): AudioFrame {
  return {
    rms: 0,
    noiseFloor: 0.01,
    level: 0,
    voiced: false,
    onset: false,
    release: false,
    voicedMs: 0,
    silenceMs: 0,
    flatness: 0,
    centroid: 0,
    lowBandRatio: 0,
    zcr: 0,
    vowelLikeness: 0,
    f1: 0,
    f2: 0,
    stopBurst: false,
    ...p,
  };
}

/** A pure tone — tonal, low ZCR (a stand-in for a sustained vowel). */
export function sineTime(freq: number, amp: number, n = 1024, sr = 44100): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return a;
}

/** Deterministic white-ish noise via an LCG (no Math.random) — high ZCR. */
export function noiseTime(amp: number, n = 1024, seed = 1): Float32Array {
  let s = seed >>> 0;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    a[i] = (s / 0xffffffff) * 2 * amp - amp;
  }
  return a;
}

/** dB spectrum with energy concentrated in a few bins around `peakBin` (tonal). */
export function tonalSpectrumDb(peakBin: number, n = 512): Float32Array {
  const a = new Float32Array(n).fill(-140);
  for (let i = -2; i <= 2; i++) {
    const b = peakBin + i;
    if (b >= 0 && b < n) a[b] = -10 - Math.abs(i) * 12;
  }
  return a;
}

/** Uniform dB across all bins (white-noise spectrum). */
export function flatSpectrumDb(db: number, n = 512): Float32Array {
  return new Float32Array(n).fill(db);
}

/** Effectively-silent spectrum. */
export function silentSpectrumDb(n = 512): Float32Array {
  return new Float32Array(n).fill(-140);
}

/**
 * A vowel-shaped dB spectrum: two broad formant lobes at f1Hz / f2Hz over a
 * faint floor. Round-trips through the engine's dB→linear conversion so
 * `estimateFormants` recovers ~f1/f2 (Rung 2, #5).
 */
export function vowelSpectrumDb(
  f1Hz: number,
  f2Hz: number,
  sr = 44100,
  n = 512,
): Float32Array {
  const hzPerBin = sr / 2 / n;
  const b1 = f1Hz / hzPerBin;
  const b2 = f2Hz / hzPerBin;
  const sigma = 3.5;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lin =
      1.0 * Math.exp(-((i - b1) ** 2) / (2 * sigma ** 2)) +
      0.8 * Math.exp(-((i - b2) ** 2) / (2 * sigma ** 2)) +
      1e-5;
    a[i] = 20 * Math.log10(lin);
  }
  return a;
}

/**
 * A stand-in for AnalyserNode that fills the engine's buffers from whatever
 * `time` / `freqDb` arrays are currently assigned. Swap those between phases to
 * script "ambient → vowel → silence" without a microphone.
 */
export class FakeAnalyser implements SpectralAnalyserLike {
  fftSize = 1024;
  frequencyBinCount = 512;
  time: Float32Array = new Float32Array(this.fftSize);
  freqDb: Float32Array = new Float32Array(this.frequencyBinCount).fill(-140);

  getFloatTimeDomainData(buf: Float32Array): void {
    buf.set(this.time.subarray(0, buf.length));
  }
  getFloatFrequencyData(buf: Float32Array): void {
    buf.set(this.freqDb.subarray(0, buf.length));
  }
}
