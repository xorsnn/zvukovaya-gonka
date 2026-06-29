/**
 * PhoneticFeatures — pure, side-effect-free DSP.
 *
 * DESIGN RULE (still non-negotiable): this is NOT speech recognition. We never
 * decode a word, phoneme, or vowel identity here. We measure cheap *acoustic*
 * features of a sound — how tonal vs noisy it is, where its energy sits — and
 * blend them into a single 0..1 "how vowel-like is this sound" score. A scream
 * and a sustained «о-о-о» differ in these features; *which* vowel it is, we do
 * not and will not ask.
 *
 * Every function takes plain `Float32Array`s and returns a number, so they are
 * trivially unit-testable on synthetic buffers with no microphone, no
 * AudioContext, and no AnalyserNode.
 *
 * Inputs:
 *   - time-domain buffers are raw samples in roughly [-1, 1].
 *   - magnitude buffers are LINEAR magnitudes (not dB). The AnalyserNode hands
 *     back dB, so the caller converts once (`mag = 10^(dB/20)`) before calling
 *     these — see {@link AudioEngine}. Bin 0 (DC) is skipped by every spectral
 *     function so a DC offset can't skew the result.
 */

/** Default upper reference for centroid scoring when no per-child baseline is
 * known. Deliberately generous (a 3-yr-old's formants are high) so a normal
 * child vowel is not mistaken for noise. See the age note in issue #1. */
export const DEFAULT_CENTROID_REF = 3000; // Hz

/**
 * Weights for the {@link vowelLikeness} blend (sum to 1).
 *
 * REAL-MIC TUNING (issue #1 follow-up): spectral flatness — the feature the
 * original spec leaned on hardest — proved unreliable on a live microphone. A
 * real FFT has hundreds of near-silent noise-floor bins (~−100 dB); those
 * dominate the geometric mean, so flatness reads ≈0 ("tonal") for BOTH a vowel
 * AND a hissy «шшш». With 0.4 of the weight that near-constant wrongly propped
 * noise over the hold threshold (a fricative caught the mouse like a vowel).
 *
 * So flatness is dropped from the blend (still computed, for the debug overlay)
 * and the weight moves to the three noise-floor-robust features: zero-crossing
 * rate, spectral centroid, and the low-band energy ratio. These cleanly separate
 * a vowel (low ZCR, dark centroid, low-heavy energy) from a fricative/hiss (high
 * ZCR, bright centroid, high-heavy energy). ZCR leads — it is time-domain, so it
 * never sees the FFT noise floor at all.
 */
export const VOWEL_WEIGHTS = {
  zcr: 0.45,
  centroid: 0.25,
  lowBand: 0.3,
} as const;

/**
 * Zero-crossing-rate knee. At/below {@link ZCR_LOW} the sound is fully "vowel"
 * on this axis; at/above {@link ZCR_HIGH} it is fully "noise". A held vowel sits
 * ~0.02–0.15; a sibilant /ш/ or hiss ~0.30–0.6, so the knee separates them
 * sharply instead of the soft `1 − zcr` ramp (which left fricatives mid-scale).
 *
 * {@link ZCR_SILENCE} is the catch: true silence / DC also has ~0 crossings, but
 * that is the *absence* of a signal, not a pure tone. Without a floor, the soft
 * decay tail after a stop (when the engine's smoothed RMS still reads "voiced"
 * for ~400 ms but the samples are ~0) would score as a sustained vowel and keep
 * a too-short hold alive. So ZCR below this floor scores 0 on the vowel axis.
 */
export const ZCR_SILENCE = 0.004;
export const ZCR_LOW = 0.05;
export const ZCR_HIGH = 0.3;

export interface SpectralFeatures {
  /** 0..1 — geometric/arithmetic mean ratio. ~0 tonal, ~1 noisy. */
  flatness: number;
  /** Hz — energy-weighted mean frequency. */
  centroid: number;
  /** 0..1 — fraction of energy below 1 kHz. */
  lowBandRatio: number;
  /** 0..1 — fraction of sign changes in the time signal. */
  zcr: number;
}

/** Optional per-child calibration: scores centroid relative to her own
 * sustained-vowel baseline instead of the fixed adult reference. */
export interface VowelBaseline {
  /** Mean spectral centroid (Hz) measured while she held a steady vowel. */
  centroid: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Zero-crossing rate: fraction of adjacent-sample sign changes, 0..1. A tonal
 * vowel crosses zero slowly (low ZCR, ~<0.15); a hissy fricative or a shriek
 * crosses fast (high ZCR, ~>0.3). Pitch-robust: it does not care about absolute
 * f0, only how noise-like the waveform is.
 */
export function zeroCrossingRate(time: Float32Array): number {
  if (time.length < 2) return 0;
  let crossings = 0;
  let prev = time[0];
  for (let i = 1; i < time.length; i++) {
    const cur = time[i];
    // Count a crossing only on a real sign flip (treat exact 0 as no flip).
    if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) crossings++;
    if (cur !== 0) prev = cur;
  }
  return crossings / (time.length - 1);
}

/**
 * Spectral flatness: `exp(mean(log mag)) / mean(mag)` over bins 1..N-1, 0..1.
 * A pure tone concentrates energy in one bin → geometric mean ≪ arithmetic mean
 * → near 0. White noise spreads energy evenly → the two means converge → near
 * 1. This is the single most useful, and most pitch-robust, vowel/noise feature.
 */
export function spectralFlatness(mag: Float32Array): number {
  const n = mag.length;
  if (n <= 1) return 0;
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    // Floor each bin so a single empty bin can't drive the geometric mean to 0.
    const m = mag[i] > 1e-10 ? mag[i] : 1e-10;
    logSum += Math.log(m);
    sum += m;
    count++;
  }
  if (count === 0 || sum <= 0) return 0;
  const geo = Math.exp(logSum / count);
  const arith = sum / count;
  return clamp01(geo / arith);
}

/**
 * Spectral centroid (Hz): `sum(f*mag) / sum(mag)` — the energy-weighted mean
 * frequency, i.e. the "brightness" of the sound. A back/low vowel is dark
 * (low centroid); a shriek or hiss is bright (high centroid). Bins map to
 * frequency by `f = i * (sampleRate/2) / mag.length` (bin `mag.length` = Nyquist).
 */
export function spectralCentroid(mag: Float32Array, sampleRate: number): number {
  const n = mag.length;
  if (n <= 1) return 0;
  const hzPerBin = sampleRate / 2 / n;
  let weighted = 0;
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const m = mag[i];
    weighted += i * hzPerBin * m;
    sum += m;
  }
  return sum > 0 ? weighted / sum : 0;
}

/**
 * Low-band energy ratio: energy below 1 kHz / total energy, 0..1. Uses power
 * (mag²). Vowels keep most of their energy in the low formants + fundamental,
 * so the ratio is high; fricatives/shrieks push energy up high, so it is low.
 */
export function lowBandRatio(mag: Float32Array, sampleRate: number): number {
  const n = mag.length;
  if (n <= 1) return 0;
  const hzPerBin = sampleRate / 2 / n;
  const cutoffBin = Math.min(n, Math.max(1, Math.round(1000 / hzPerBin)));
  let low = 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const p = mag[i] * mag[i];
    if (i < cutoffBin) low += p;
    total += p;
  }
  return total > 0 ? clamp01(low / total) : 0;
}

/**
 * vowelLikeness — the single 0..1 verdict the rest of the game grades on.
 *
 * A weighted blend of the three noise-floor-robust features (see
 * {@link VOWEL_WEIGHTS}; flatness is intentionally excluded — see the note
 * there). Each sub-term is normalized to 0..1 where 1 = "more vowel-like":
 *   - zcr      → a sharp knee between {@link ZCR_LOW} and {@link ZCR_HIGH}
 *               (slow zero-crossing is vowel-like; a hiss crosses fast)
 *   - centroid → `1 - centroid/ref` (dark is vowel-like; `ref` is the child's
 *               baseline*2.2 when calibrated, else a generous adult default)
 *   - lowBand  → `lowBandRatio` (energy concentrated low is vowel-like)
 *
 * `baseline` (optional) makes the centroid term *relative* to the child's own
 * sustained vowel, which matters because a 3-yr-old's formants are high enough
 * that a fixed adult reference would score her correct vowel as noise.
 */
export function vowelLikeness(
  features: SpectralFeatures,
  baseline?: VowelBaseline | null,
): number {
  const { centroid, lowBandRatio: low, zcr } = features;
  const centroidRef = baseline
    ? Math.max(DEFAULT_CENTROID_REF * 0.8, baseline.centroid * 2.2)
    : DEFAULT_CENTROID_REF;
  const zcrScore =
    zcr < ZCR_SILENCE ? 0 : clamp01((ZCR_HIGH - zcr) / (ZCR_HIGH - ZCR_LOW));
  const centroidScore = clamp01(1 - centroid / centroidRef);
  const score =
    VOWEL_WEIGHTS.zcr * zcrScore +
    VOWEL_WEIGHTS.centroid * centroidScore +
    VOWEL_WEIGHTS.lowBand * clamp01(low);
  return clamp01(score);
}
