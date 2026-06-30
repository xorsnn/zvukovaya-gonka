import { describe, it, expect } from "vitest";
import {
  zeroCrossingRate,
  spectralFlatness,
  spectralCentroid,
  lowBandRatio,
  vowelLikeness,
  estimateFormants,
  vowelMatch,
} from "../src/audio/PhoneticFeatures";
import { sineTime, noiseTime } from "./_helpers";

const SR = 44100;
const N = 512; // frequencyBinCount for fftSize 1024
const HZ_PER_BIN = SR / 2 / N; // ≈43 Hz

/** A linear-magnitude spectrum with a single bin of energy. */
function magWithPeak(bin: number, n = N): Float32Array {
  const a = new Float32Array(n);
  a[bin] = 1;
  return a;
}

/**
 * A vowel-shaped linear-magnitude spectrum: two broad Gaussian formant lobes at
 * f1Hz / f2Hz over a faint noise floor. `sigmaBin` is wide enough that the lobes
 * read as resonances, not single tones.
 */
function formantSpectrum(
  f1Hz: number,
  f2Hz: number,
  { a1 = 1, a2 = 0.8, sigmaBin = 3.5 } = {},
): Float32Array {
  const a = new Float32Array(N).fill(1e-6);
  const b1 = f1Hz / HZ_PER_BIN;
  const b2 = f2Hz / HZ_PER_BIN;
  for (let i = 1; i < N; i++) {
    a[i] +=
      a1 * Math.exp(-((i - b1) ** 2) / (2 * sigmaBin ** 2)) +
      a2 * Math.exp(-((i - b2) ** 2) / (2 * sigmaBin ** 2));
  }
  return a;
}

describe("zeroCrossingRate", () => {
  it("is 0 for silence", () => {
    expect(zeroCrossingRate(new Float32Array(1024))).toBe(0);
  });

  it("is low for a sustained low tone (vowel-like)", () => {
    expect(zeroCrossingRate(sineTime(220, 0.3))).toBeLessThan(0.05);
  });

  it("is high for white noise (shriek/fricative-like)", () => {
    expect(zeroCrossingRate(noiseTime(0.3))).toBeGreaterThan(0.3);
  });
});

describe("spectralFlatness", () => {
  it("is near 0 for a tonal spectrum", () => {
    expect(spectralFlatness(magWithPeak(7))).toBeLessThan(0.1);
  });

  it("is near 1 for a flat (noisy) spectrum", () => {
    expect(spectralFlatness(new Float32Array(N).fill(1))).toBeGreaterThan(0.9);
  });
});

describe("spectralCentroid", () => {
  it("is low when energy sits in low bins", () => {
    expect(spectralCentroid(magWithPeak(7), SR)).toBeLessThan(500);
  });

  it("is high when energy sits in high bins", () => {
    expect(spectralCentroid(magWithPeak(300), SR)).toBeGreaterThan(3000);
  });
});

describe("lowBandRatio", () => {
  it("is high when energy is below 1 kHz (vowel-like)", () => {
    expect(lowBandRatio(magWithPeak(5), SR)).toBeGreaterThan(0.9);
  });

  it("is low when energy is up high (fricative/shriek-like)", () => {
    expect(lowBandRatio(magWithPeak(300), SR)).toBeLessThan(0.1);
  });
});

describe("vowelLikeness", () => {
  it("scores a tonal, low, steady sound as vowel-like (high)", () => {
    const vl = vowelLikeness({
      flatness: 0.05,
      centroid: 400,
      lowBandRatio: 0.9,
      zcr: 0.05,
    });
    expect(vl).toBeGreaterThan(0.8);
  });

  it("scores a flat, bright, hissy sound as not vowel-like (low)", () => {
    const vl = vowelLikeness({
      flatness: 0.95,
      centroid: 6000,
      lowBandRatio: 0.05,
      zcr: 0.5,
    });
    expect(vl).toBeLessThan(0.3);
  });

  it("baseline calibration rescues a high-formant child vowel", () => {
    // A 3-yr-old's vowel has a high centroid that the fixed adult reference
    // would over-penalize; her own baseline must lift the score (the #1 age note).
    const childVowel = {
      flatness: 0.1,
      centroid: 2200,
      lowBandRatio: 0.6,
      zcr: 0.1,
    };
    const withoutBaseline = vowelLikeness(childVowel, null);
    const withBaseline = vowelLikeness(childVowel, { centroid: 2200 });
    expect(withBaseline).toBeGreaterThan(withoutBaseline);
  });

  // Real-mic regression: with an FFT noise floor, flatness can't tell a vowel
  // from «шшш» (both look tonal), which is exactly why it was caught propping up
  // noise on the live game. vowelLikeness must still separate them cleanly.
  it("separates a vowel from «шшш» on realistic noise-floor spectra", () => {
    const noiseFloor = () => new Float32Array(N).fill(1e-5);

    const vowelMag = noiseFloor(); // harmonics in the low band (f0 ~215 Hz)
    for (const b of [5, 10, 15, 20, 25]) vowelMag[b] = 0.12;
    const shhhMag = noiseFloor(); // broadband hiss ~2.6–6 kHz
    for (let b = 60; b < 140; b++) shhhMag[b] = 0.02;

    const feat = (mag: Float32Array, time: Float32Array) => ({
      flatness: spectralFlatness(mag),
      centroid: spectralCentroid(mag, SR),
      lowBandRatio: lowBandRatio(mag, SR),
      zcr: zeroCrossingRate(time),
    });
    const vowel = feat(vowelMag, sineTime(220, 0.3));
    const shhh = feat(shhhMag, noiseTime(0.3));

    // The smoking gun: flatness does NOT separate them (both read ~tonal).
    expect(Math.abs(vowel.flatness - shhh.flatness)).toBeLessThan(0.2);
    // But the verdict does, with wide margin.
    expect(vowelLikeness(vowel)).toBeGreaterThan(0.6);
    expect(vowelLikeness(shhh)).toBeLessThan(0.3);
    expect(vowelLikeness(vowel) - vowelLikeness(shhh)).toBeGreaterThan(0.4);
  });
});

// --- Rung 2 (#5): coarse vowel identity -----------------------------------

// Child-ish formant centres (Hz) for synthetic vowels, high per the #1 age note.
const CHILD = {
  а: { f1: 850, f2: 1400 },
  о: { f1: 560, f2: 950 },
  и: { f1: 400, f2: 2600 },
  у: { f1: 420, f2: 760 },
};

describe("estimateFormants", () => {
  it("recovers the two formant lobes of a vowel within tolerance", () => {
    const { f1, f2 } = estimateFormants(formantSpectrum(CHILD.а.f1, CHILD.а.f2), SR);
    expect(Math.abs(f1 - CHILD.а.f1)).toBeLessThan(130);
    expect(Math.abs(f2 - CHILD.а.f2)).toBeLessThan(180);
    expect(f2).toBeGreaterThan(f1); // F2 is always the higher resonance
  });

  it("separates а from о: open «а» has a clearly higher F1", () => {
    const a = estimateFormants(formantSpectrum(CHILD.а.f1, CHILD.а.f2), SR);
    const o = estimateFormants(formantSpectrum(CHILD.о.f1, CHILD.о.f2), SR);
    expect(a.f1).toBeGreaterThan(o.f1 + 150); // AC#1: а and о are separable
  });

  it("separates и from а: front «и» has a far higher F2", () => {
    const i = estimateFormants(formantSpectrum(CHILD.и.f1, CHILD.и.f2), SR);
    const a = estimateFormants(formantSpectrum(CHILD.а.f1, CHILD.а.f2), SR);
    expect(i.f2).toBeGreaterThan(a.f2 + 600);
  });

  it("resolves «у» — both formants low and close, the estimator's hardest case", () => {
    // «у» brushes the F2 search-band floor and min-gap, so it stresses the band
    // logic that could otherwise collapse F2 onto F1 or drop it.
    const { f1, f2 } = estimateFormants(formantSpectrum(CHILD.у.f1, CHILD.у.f2), SR);
    expect(Math.abs(f1 - CHILD.у.f1)).toBeLessThan(150);
    expect(Math.abs(f2 - CHILD.у.f2)).toBeLessThan(200);
    expect(f2).toBeGreaterThan(f1); // still two distinct resonances
  });

  it("reports no formant (0/0) for an effectively-silent spectrum", () => {
    expect(estimateFormants(new Float32Array(N), SR)).toEqual({ f1: 0, f2: 0 });
  });

  it("reports no formant (0/0) for a degenerate empty / single-bin spectrum", () => {
    // The n<=1 guard also dodges a sampleRate/2/n divide-by-zero.
    expect(estimateFormants(new Float32Array(0), SR)).toEqual({ f1: 0, f2: 0 });
    expect(estimateFormants(new Float32Array(1), SR)).toEqual({ f1: 0, f2: 0 });
  });
});

describe("vowelMatch", () => {
  // She calibrated holding «а»; that anchors her formant space.
  const baseA = { centroid: 1100, f1: CHILD.а.f1, f2: CHILD.а.f2 };

  it("AC#2: for an «о» target, a held «о» matches better than a held «а» — but «а» still scores", () => {
    const matchO = vowelMatch(CHILD.о, "о", baseA);
    const matchA = vowelMatch(CHILD.а, "о", baseA);
    expect(matchO).toBeGreaterThan(matchA); // «о» is the better match
    expect(matchA).toBeGreaterThan(0.1); // but «а» is graded, not zeroed out
    expect(matchO).toBeGreaterThan(0.6); // a real «о» scores strongly
  });

  it("for an «и» target, a held «и» beats a held «а» (F2 carries the front/back identity)", () => {
    expect(vowelMatch(CHILD.и, "и", baseA)).toBeGreaterThan(vowelMatch(CHILD.а, "и", baseA));
  });

  it("for a «у» target, a held «у» beats a held «а» (both formants low)", () => {
    expect(vowelMatch(CHILD.у, "у", baseA)).toBeGreaterThan(vowelMatch(CHILD.а, "у", baseA));
  });

  it("is speaker-relative: scaling her whole vowel space leaves the match unchanged", () => {
    // A child with formants 1.25× higher, calibrated the same way, gets the same
    // verdict — the score lives in her space, not absolute Hz (the #1 age note).
    const k = 1.25;
    const big = { f1: CHILD.о.f1 * k, f2: CHILD.о.f2 * k };
    const bigBase = { centroid: 1100, f1: CHILD.а.f1 * k, f2: CHILD.а.f2 * k };
    const small = vowelMatch(CHILD.о, "о", baseA);
    const large = vowelMatch(big, "о", bigBase);
    expect(Math.abs(small - large)).toBeLessThan(1e-9);
  });

  it("preserves the а-vs-о ordering even if she calibrated on the 'wrong' vowel", () => {
    // Anchor taken from her «о» instead of «а»: the absolute centre drifts, but
    // her «о» must STILL out-match her «а» for an «о» target (only the ordering
    // matters for the graded drive).
    const baseO = { centroid: 900, f1: CHILD.о.f1, f2: CHILD.о.f2 };
    expect(vowelMatch(CHILD.о, "о", baseO)).toBeGreaterThan(vowelMatch(CHILD.а, "о", baseO));
  });

  it("returns neutral 1 when there is no formant baseline (degrades to Rung-1 feel)", () => {
    expect(vowelMatch(CHILD.о, "о", { centroid: 1100 })).toBe(1);
    expect(vowelMatch(CHILD.о, "о", null)).toBe(1);
  });

  it("returns neutral 1 when the estimate is missing (silent frame)", () => {
    expect(vowelMatch({ f1: 0, f2: 0 }, "о", baseA)).toBe(1);
  });

  it("returns neutral 1 for a half estimate or half baseline (single formant)", () => {
    // A breathy/low vowel can leave the F2 band empty → f2 = 0; that is "no
    // opinion", not a real match, so it must not penalise the chase.
    expect(vowelMatch({ f1: 600, f2: 0 }, "о", baseA)).toBe(1);
    expect(vowelMatch(CHILD.о, "о", { centroid: 1100, f1: CHILD.а.f1 })).toBe(1);
  });

  it("returns neutral 1 for a NaN formant (never poisons driveQuality)", () => {
    // `!(f > 0)` rejects NaN where `f <= 0` would not — a NaN must degrade to
    // neutral, never propagate into a NaN driveQuality that freezes the cat.
    expect(vowelMatch({ f1: NaN, f2: 950 }, "о", baseA)).toBe(1);
    expect(vowelMatch({ f1: 560, f2: NaN }, "о", baseA)).toBe(1);
  });
});
