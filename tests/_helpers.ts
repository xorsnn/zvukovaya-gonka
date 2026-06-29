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
