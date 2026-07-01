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
  /** Mean first formant (Hz) of her calibration vowel — Rung 2 (#5). Optional:
   * absent when the mic-check produced too little voiced audio to estimate. */
  f1?: number;
  /** Mean second formant (Hz) of her calibration vowel — Rung 2 (#5). */
  f2?: number;
}

/** The four nucleus vowels a scene can ask for (Rung 2, #5). NOT a phoneme
 * decode — only a coarse formant-region label the drive grades *toward*. */
export type Vowel = "а" | "о" | "у" | "и";

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

// ===========================================================================
// Rung 2 (#5) — coarse vowel identity (which vowel: а / о / у / и).
//
// STILL NOT speech recognition: we estimate two formant *regions* (F1/F2) and
// score how close the held sound sits to the scene's target vowel — relative to
// the child's OWN calibrated vowel space, never absolute Hz. The result is a
// soft 0..1 *match*, folded into chase speed as a gentle, bounded factor by the
// matcher. A "wrong" vowel is never gated out; it just chases a little slower.
// ===========================================================================

/**
 * Canonical formant centres (Hz) for the four nucleus vowels, an adult-ish
 * reference. We never use these as absolute thresholds: {@link vowelMatch}
 * anchors them to the child's own calibration vowel (treated as «а») and uses
 * only the *ratios* between vowels, which are far more speaker-invariant than
 * the absolute frequencies. So a 3-yr-old's high, variable formants are handled
 * by scaling the whole map to her voice — see the age note in issue #1.
 *
 *   а — open, central:    high F1, mid  F2
 *   о — back, rounded:    mid  F1, low  F2
 *   у — close, back:      low  F1, low  F2
 *   и — close, front:     low  F1, high F2
 */
export const VOWEL_FORMANTS: Record<Vowel, { f1: number; f2: number }> = {
  а: { f1: 700, f2: 1300 },
  о: { f1: 500, f2: 900 },
  у: { f1: 320, f2: 700 },
  и: { f1: 300, f2: 2200 },
};

/** Search band for F1 (Hz). Wide on the high side so a child's open «а» (F1 up
 * to ~1 kHz) is not clipped. */
export const F1_BAND = { min: 200, max: 1300 } as const;
/** Search band for F2 (Hz). Wide on the high side for a child's front «и». */
export const F2_BAND = { min: 700, max: 3600 } as const;
/** F2 must sit at least this far above the chosen F1, so a single strong low
 * lobe can't be picked as both formants. */
export const F2_MIN_GAP = 250; // Hz
/** Spectral-envelope smoothing width (Hz): wide enough to blur individual
 * harmonics of a toddler's f0 (~250–400 Hz) so the peaks we pick are formant
 * resonances, not pitch harmonics. */
export const FORMANT_ENVELOPE_HZ = 260;
/** Below this total linear-magnitude energy the spectrum is treated as silent
 * and no formant is reported (returns 0/0 → {@link vowelMatch} stays neutral). */
export const FORMANT_SILENCE_ENERGY = 1e-4;
/** Log-frequency spread (in nats) of the vowel-match Gaussian. ~0.4 means a
 * formant off by a factor of e^0.4 ≈ 1.5× scores ~0.6 — deliberately gentle. */
export const VOWEL_MATCH_SIGMA = 0.42;

/**
 * estimateFormants — a coarse, robust F1/F2 estimate by spectral-envelope
 * peak-picking. Pure: takes a LINEAR-magnitude spectrum (same convention as the
 * other spectral functions) and returns the two dominant low/mid resonances.
 *
 * Method (kept deliberately simple — validate on the `?debug` overlay before
 * reaching for LPC, per issue #5):
 *   1. Smooth the magnitude spectrum with a moving average ~{@link
 *      FORMANT_ENVELOPE_HZ} wide, so individual pitch harmonics blur into the
 *      vocal-tract envelope and the peaks we find are formants, not harmonics.
 *   2. F1 = frequency of the envelope's strongest bin within {@link F1_BAND}.
 *   3. F2 = strongest bin within {@link F2_BAND} *and* at least
 *      {@link F2_MIN_GAP} above F1, so the two never collapse onto one lobe.
 *
 * Returns `{ f1: 0, f2: 0 }` for an effectively-silent spectrum so callers can
 * treat 0 as "no estimate" (neutral) rather than a real low formant.
 *
 * `scratch` (optional) is a caller-owned envelope buffer of length ≥ `mag.length`.
 * Pass one to avoid a per-frame heap allocation on the audio hot path (the engine
 * reuses a single buffer, like its other spectral scratch arrays); omit it and a
 * fresh array is allocated, which keeps the pure-function tests allocation-free.
 */
export function estimateFormants(
  mag: Float32Array,
  sampleRate: number,
  scratch?: Float32Array,
): { f1: number; f2: number } {
  const n = mag.length;
  if (n <= 1) return { f1: 0, f2: 0 };
  const hzPerBin = sampleRate / 2 / n;

  // Bail on silence before doing any work (and so silence reports no formant).
  let energy = 0;
  for (let i = 1; i < n; i++) energy += mag[i];
  if (energy < FORMANT_SILENCE_ENERGY) return { f1: 0, f2: 0 };

  // 1) moving-average envelope (half-window in bins). Reuse the caller's buffer
  // when it's big enough; the loop overwrites env[0..n-1] in full, so stale tail
  // bytes from a larger buffer are never read.
  const half = Math.max(1, Math.round(FORMANT_ENVELOPE_HZ / hzPerBin / 2));
  const env = scratch && scratch.length >= n ? scratch : new Float32Array(n);
  let acc = 0;
  // running sum over [i-half, i+half]; seed with bins [0, half].
  for (let i = 0; i <= Math.min(n - 1, half); i++) acc += mag[i];
  for (let i = 0; i < n; i++) {
    const enter = i + half;
    const leave = i - half - 1;
    if (i > 0) {
      if (enter < n) acc += mag[enter];
      if (leave >= 0) acc -= mag[leave];
    }
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    env[i] = acc / (hi - lo + 1);
  }

  // Strongest envelope bin whose frequency lies in [loHz, hiHz].
  const peakIn = (loHz: number, hiHz: number): { bin: number; hz: number } => {
    const loBin = Math.max(1, Math.ceil(loHz / hzPerBin));
    const hiBin = Math.min(n - 1, Math.floor(hiHz / hzPerBin));
    let bestBin = -1;
    let best = -Infinity;
    for (let i = loBin; i <= hiBin; i++) {
      if (env[i] > best) {
        best = env[i];
        bestBin = i;
      }
    }
    return { bin: bestBin, hz: bestBin < 0 ? 0 : bestBin * hzPerBin };
  };

  const f1 = peakIn(F1_BAND.min, F1_BAND.max);
  const f2 = peakIn(Math.max(F2_BAND.min, f1.hz + F2_MIN_GAP), F2_BAND.max);
  return { f1: f1.hz, f2: f2.hz };
}

/**
 * vowelMatch — 0..1 closeness of an observed (F1, F2) to the scene's target
 * vowel, scored in the CHILD'S calibrated formant space, not absolute Hz.
 *
 * The baseline carries her calibration vowel's F1/F2 (treated as «а»). We place
 * the target where it should sit *for her* by scaling the canonical map
 * ({@link VOWEL_FORMANTS}) by her-«а» ÷ reference-«а», then score log-frequency
 * distance with a gentle Gaussian ({@link VOWEL_MATCH_SIGMA}).
 *
 * Why anchor at «а» and use ratios: a consistent linear scale preserves the
 * *relative ordering* of her vowels (her «о» stays below her «а») no matter
 * which vowel she actually calibrated on — only the absolute centre drifts, and
 * the drive only needs the ordering. Combined with the matcher's bounded factor
 * and `assist`, a mis-anchored baseline can never punish a real attempt.
 *
 * Returns 1 (neutral — "no opinion") when there is no usable estimate or no
 * calibrated formant baseline, so Rung 2 silently degrades to the Rung-1 feel.
 */
export function vowelMatch(
  formants: { f1: number; f2: number },
  target: Vowel,
  baseline?: VowelBaseline | null,
): number {
  const { f1, f2 } = formants;
  // `!(f > 0)` (not `f <= 0`) so a NaN formant also degrades to neutral — NaN
  // would otherwise slip the guard (`NaN <= 0` is false) and poison driveQuality.
  if (!baseline || !baseline.f1 || !baseline.f2 || !(f1 > 0) || !(f2 > 0)) {
    return 1;
  }
  const refA = VOWEL_FORMANTS["а"];
  const refT = VOWEL_FORMANTS[target];
  const expF1 = baseline.f1 * (refT.f1 / refA.f1);
  const expF2 = baseline.f2 * (refT.f2 / refA.f2);
  const d1 = Math.log(f1 / expF1);
  const d2 = Math.log(f2 / expF2);
  const dist2 = d1 * d1 + d2 * d2;
  const s = 2 * VOWEL_MATCH_SIGMA * VOWEL_MATCH_SIGMA;
  return clamp01(Math.exp(-dist2 / s));
}

/** All four nucleus vowels, in a fixed order so {@link classifyVowel}'s argmax
 * breaks ties deterministically (а wins a tie over о, etc.). */
export const VOWELS: readonly Vowel[] = ["а", "о", "у", "и"] as const;

/**
 * The result of scoring a held sound against ALL four target vowels at once —
 * the read-only "which vowel is this most like?" readout the caregiver chip
 * shows (#13). It is the argmax companion to {@link vowelMatch}, which scores
 * against ONE target. STILL NOT speech recognition: same coarse, her-calibrated
 * formant-region match, only run for every vowel and reported, never fed back
 * into how the chase grades.
 */
export interface VowelClassification {
  /** The argmax vowel, or null = "no opinion" (gated out / no usable estimate). */
  vowel: Vowel | null;
  /** 0..1 — the winning vowel's match score (the argmax value). */
  confidence: number;
  /** Per-vowel 0..1 match (each === {@link vowelMatch} for that vowel). */
  scores: Record<Vowel, number>;
}

/**
 * classifyVowel — score an observed (F1, F2) against every nucleus vowel and
 * report the most-likely one. Pure: feed it canned formants in a test (AC#1/#2).
 *
 * For a usable baseline + estimate, `scores[v]` is exactly {@link vowelMatch}
 * for that vowel (same «а»-anchor, same ratios, same {@link VOWEL_MATCH_SIGMA}),
 * `vowel` is the argmax, and `confidence` is the winning score.
 *
 * NEUTRAL GUARD (up front, before any `vowelMatch` call): with no usable formant
 * baseline (`baseline.f1`/`f2` missing) or no estimate (`f1`/`f2` is `0`/`NaN` —
 * `0` is the silence sentinel `estimateFormants` returns) we return all-zero
 * scores and `vowel: null`. Scores are 0 (NOT vowelMatch's neutral 1) on purpose:
 * calling `vowelMatch` with no baseline returns 1 for EVERY vowel — a meaningless
 * 4-way tie — so we short-circuit instead. Uses the same NaN-safe `!(f > 0)`
 * check as `vowelMatch`, so a NaN formant also degrades to "no opinion".
 *
 * This function does NO gating or smoothing — it is the raw per-frame argmax. The
 * flicker gate + EMA live in {@link LetterIndicator}.
 */
export function classifyVowel(
  formants: { f1: number; f2: number },
  baseline?: VowelBaseline | null,
): VowelClassification {
  const { f1, f2 } = formants;
  if (!baseline || !baseline.f1 || !baseline.f2 || !(f1 > 0) || !(f2 > 0)) {
    return { vowel: null, confidence: 0, scores: { а: 0, о: 0, у: 0, и: 0 } };
  }
  const scores: Record<Vowel, number> = { а: 0, о: 0, у: 0, и: 0 };
  let best: Vowel | null = null;
  let bestScore = -Infinity;
  for (const v of VOWELS) {
    const s = vowelMatch(formants, v, baseline);
    scores[v] = s;
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return { vowel: best, confidence: bestScore, scores };
}

// ===========================================================================
// Rung 3 (#6) — coarse consonant class & the real «т» stop.
//
// STILL NOT speech recognition: we read the recent ENVELOPE + texture and label
// the *release shape*, never the phoneme. Three coarse classes the chase cares
// about:
//   - stop      «т»/«к»: a sustained voiced run, then a near-silence CLOSURE,
//               optionally a burst (a fresh re-onset, the «т» release).
//   - fricative «ш»/«с»: a sustained HISS — voiced-above-floor but high-ZCR
//               throughout (already low `vowelLikeness` in Rung 1).
//   - sonorant  «р»/«м»: a continuous low-ZCR voiced HUM with NO closure gap.
// The classifier is pure and gates nothing — it only LABELS (the debug overlay,
// the burst highlight) and informs the matcher's *bonus* burst-catch. A "wrong"
// class never withholds a catch (leniency); see the matcher.
// ===========================================================================

/** The coarse release classes the chase distinguishes (Rung 3, #6). */
export type ConsonantClass = "stop" | "sonorant" | "fricative" | "none";

/**
 * One frame of the recent envelope the classifier reads. Deliberately tiny:
 * `voiced` (above the engine's off-threshold) plus `zcr` (the vowel/hiss
 * texture) are all the coarse stop / sonorant / fricative split needs — no new
 * heavy DSP, per issue #6.
 */
export interface ReleaseFrame {
  /** Sound present above the noise floor this frame. */
  voiced: boolean;
  /** Zero-crossing rate 0..1 — high for a hiss, low for a tonal vowel/sonorant. */
  zcr: number;
}

/** A voiced frame at/above this ZCR is hiss-like (a fricative), not a tonal
 * vowel/sonorant. Shares the {@link ZCR_HIGH} knee used by `vowelLikeness`. */
export const CONSONANT_FRICATIVE_ZCR = ZCR_HIGH;
/** Fraction of the *voiced* frames that must be hiss-like to call the whole
 * release a fricative. */
export const CONSONANT_FRICATIVE_FRAC = 0.5;
/** A run of at least this many non-voiced frames after the hold is a real
 * CLOSURE (a stop), not a momentary flicker. */
export const CONSONANT_GAP_FRAMES = 3;
/** A voiced run needs at least this many consecutive frames to count as a
 * sustained hold/hum — so a lone click is "none", not a sonorant. */
export const CONSONANT_MIN_VOICED_FRAMES = 3;

/**
 * classifyConsonant — label a recent release window as a stop, a sonorant hum,
 * a fricative hiss, or none. Pure: feed it a canned array in a test (AC#1).
 *
 * Decision order (coarsest, most distinctive first):
 *   1. fricative — at least half of the *voiced* frames are hiss-like (high ZCR),
 *      i.e. the `>= CONSONANT_FRICATIVE_FRAC` (0.5) knee. A «шшш» is
 *      voiced-above-floor throughout but never tonal.
 *   2. stop — a sustained voiced run is followed (anywhere after) by a real
 *      near-silence CLOSURE of ≥ {@link CONSONANT_GAP_FRAMES} non-voiced frames.
 *      Captures «vowel → closure → burst → silence» and plain «vowel → silence»
 *      alike; the optional re-onset burst only makes the stop crisper.
 *   3. sonorant — a sustained low-ZCR voiced run with NO closing gap. A held
 *      «р»/«м» hum reads vowel-like to Rung 1 but never finishes with a stop.
 *   4. none — too little (or too scattered) signal to say.
 *
 * CAVEAT (the stop/sonorant split is only meaningful WHILE the sound is live):
 * because *every* completed word ends in trailing silence, a held-then-released
 * sonorant («дом»'s «м» → silence) also satisfies the "stop" rule and is labelled
 * "stop"; "sonorant" only shows mid-hum, before the word ends. Telling a terminal
 * «м» from a terminal «т» needs the burst, which the real engine can't surface yet
 * (see the burst-catch note in PatternMatcher). The label is consumed only by the
 * `?debug` overlay today, so this is cosmetic — it gates nothing.
 */
export function classifyConsonant(frames: ReleaseFrame[]): ConsonantClass {
  const gapFrames = CONSONANT_GAP_FRAMES;
  const minVoiced = CONSONANT_MIN_VOICED_FRAMES;
  const n = frames.length;

  // Texture: of all voiced frames, how many are hiss-like?
  let voicedTotal = 0;
  let hissVoiced = 0;
  for (const f of frames) {
    if (f.voiced) {
      voicedTotal++;
      if (f.zcr >= CONSONANT_FRICATIVE_ZCR) hissVoiced++;
    }
  }
  if (voicedTotal < minVoiced) return "none";
  if (hissVoiced / voicedTotal >= CONSONANT_FRICATIVE_FRAC) return "fricative";

  // End of the first SUSTAINED voiced run (≥ minVoiced *consecutive* frames).
  // Scattered voicing that never sustains is "none", not a hum.
  let holdEnd = -1;
  let run = 0;
  for (let k = 0; k < n; k++) {
    if (frames[k].voiced) {
      if (++run >= minVoiced) {
        holdEnd = k + 1;
        break;
      }
    } else {
      run = 0;
    }
  }
  if (holdEnd === -1) return "none";

  // A real CLOSURE: a run of ≥ gapFrames non-voiced frames anywhere after the
  // hold. A burst (re-onset) resets the count, so the closure and the post-burst
  // silence are weighed independently — either being long enough is a stop.
  let gap = 0;
  for (let k = holdEnd; k < n; k++) {
    if (!frames[k].voiced) {
      if (++gap >= gapFrames) return "stop";
    } else {
      gap = 0;
    }
  }

  // Sustained voiced, no closing gap → a continuous sonorant hum.
  return "sonorant";
}

// ===========================================================================
// Rung 3 (#6/#12) — the REAL fast «т» stop-burst detector.
//
// The classifier above LABELS a window, but its inputs (`voiced`/`zcr`) ride the
// engine's hysteretic, 120 ms-smoothed path — too slow to see a natural «т»
// closure (50–150 ms), which is why the original burst-catch was inert on real
// speech (#11). This detector works instead over a FAST envelope (a fast-attack/
// fast-release follower over the raw RMS, surfaced by the engine), so the brief
// "energy dip (closure) → transient burst" of a «т» release is visible within a
// few frames. STILL NOT recognition: it reads the envelope *shape*, never the
// phoneme, and cannot tell «т» from «к»/«п» (place of articulation — out of
// scope, the banned ASR territory). It only answers "did a stop release just
// happen?". Pure: feed it a canned envelope array in a test (AC#4, #12).
// ===========================================================================

/** A recent-envelope peak below `noiseFloor × this` is too quiet to be a real
 * vowel, so there is nothing a stop could be releasing — bail. Mirrors the
 * engine's `onThreshold` multiplier so "loud enough to count" is one idea. */
export const STOP_BURST_LOUD_RATIO = 2.2;
/** A frame at/below `peak × this` counts as part of the closure (the near-silent
 * dip). Relative to the recent peak (not an absolute level) so the detector is
 * robust to how loud the child is. */
export const STOP_BURST_DIP_FRACTION = 0.3;
/** The release frame must rise back to at least `peak × this` (and clear the
 * loud floor) to read as a burst. Above {@link STOP_BURST_DIP_FRACTION} so the
 * closure→burst edge is unambiguous; a «т» burst is a real transient, not a
 * wobble in the tail. */
export const STOP_BURST_RISE_FRACTION = 0.45;
/** A closure shorter than this (ms) is a flicker, not a real stop. */
export const STOP_BURST_MIN_CLOSURE_MS = 40;
/** A closure longer than this (ms) is a pause / a new word, not a «т» — so a
 * "vowel … long silence … vowel again" never reads as a single stop release. */
export const STOP_BURST_MAX_CLOSURE_MS = 220;

/** Tunable bounds for {@link detectStopBurst} (all optional; omit for the
 * exported defaults). Surfaced so the real-mic tuning pass (#12, AC#6) can sweep
 * them without editing the module. */
export interface StopBurstOpts {
  loudRatio?: number;
  dipFraction?: number;
  riseFraction?: number;
  minClosureMs?: number;
  maxClosureMs?: number;
}

/**
 * detectStopBurst — does the LATEST frame of `env` complete a «т»-like
 * closure-then-burst? Pure and allocation-free.
 *
 * `env` is the recent fast-envelope history, oldest first / newest last; the
 * engine keeps the last ~20 frames (≈0.3 s). `noiseFloor` and `dtMs` come from
 * the engine. The shape we require, reading backwards from the newest frame:
 *   1. a BURST — the newest frame rises through `peak × riseFraction` (its
 *      predecessor was below it): a fresh transient, not a steady tone.
 *   2. a CLOSURE — an unbroken run of near-silent frames (≤ `peak × dipFraction`)
 *      immediately before the burst, whose length sits in
 *      [`minClosureMs`, `maxClosureMs`].
 *   3. a VOWEL — the frame just before the closure was loud (≥ the rise level):
 *      the held sound the «т» released from.
 *
 * A sustained vowel or a continuous hum has no closure (step 2 fails); a plain
 * run-out-of-breath has the closure but never rises again (step 1 fails) — so
 * neither fires (AC#4). The engine exposes the result as `frame.stopBurst`.
 */
export function detectStopBurst(
  env: ArrayLike<number>,
  noiseFloor: number,
  dtMs: number,
  opts?: StopBurstOpts,
): boolean {
  const n = env.length;
  if (n < 3) return false;

  let peak = 0;
  for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
  const loud = noiseFloor * (opts?.loudRatio ?? STOP_BURST_LOUD_RATIO);
  if (peak < loud) return false; // nothing loud enough to be a released vowel

  const dip = peak * (opts?.dipFraction ?? STOP_BURST_DIP_FRACTION);
  const rise = Math.max(loud, peak * (opts?.riseFraction ?? STOP_BURST_RISE_FRACTION));
  const minMs = opts?.minClosureMs ?? STOP_BURST_MIN_CLOSURE_MS;
  const maxMs = opts?.maxClosureMs ?? STOP_BURST_MAX_CLOSURE_MS;

  const last = n - 1;
  // 1) burst: a rising edge through `rise` on the newest frame.
  if (!(env[last] >= rise && env[last - 1] < rise)) return false;

  // 2) closure: consecutive near-silent frames immediately before the burst.
  let k = last - 1;
  let closed = 0;
  while (k >= 0 && env[k] <= dip) {
    closed++;
    k--;
  }
  if (closed === 0) return false;
  const closureMs = closed * dtMs;
  if (closureMs < minMs || closureMs > maxMs) return false;

  // 3) vowel: a loud frame somewhere before the closure (the held sound the «т»
  // released from). Scan back rather than checking only the adjacent frame — the
  // one or two frames between the steady vowel and the closure are transitional
  // (the envelope decaying), so they sit below `rise`. No loud frame before the
  // closure → a burst out of nowhere, not a stop release (rejects a lone «т»).
  for (let j = k; j >= 0; j--) {
    if (env[j] >= rise) return true;
  }
  return false;
}
