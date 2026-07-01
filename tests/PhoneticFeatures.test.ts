import { describe, it, expect } from "vitest";
import {
  zeroCrossingRate,
  spectralFlatness,
  spectralCentroid,
  lowBandRatio,
  vowelLikeness,
  estimateFormants,
  vowelMatch,
  classifyVowel,
  classifyConsonant,
  detectStopBurst,
  STOP_BURST_MAX_CLOSURE_MS,
  VOWELS,
  VOWEL_FORMANTS,
  type Vowel,
  type ReleaseFrame,
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

// --- #13: classifyVowel (all-vowel argmax) --------------------------------

describe("classifyVowel (Rung 2 argmax, #13)", () => {
  // She calibrated holding «а»; that anchors her formant space.
  const baseA = { centroid: 1100, f1: CHILD.а.f1, f2: CHILD.а.f2 };

  /** Where target `v` sits in HER space (canonical map scaled by her-«а»): a
   * frame placed here scores exactly 1 for `v`, so `v` must win the argmax. */
  const scaledCentre = (v: Vowel) => ({
    f1: baseA.f1 * (VOWEL_FORMANTS[v].f1 / VOWEL_FORMANTS["а"].f1),
    f2: baseA.f2 * (VOWEL_FORMANTS[v].f2 / VOWEL_FORMANTS["а"].f2),
  });

  it("AC#2: picks each vowel as argmax when the frame sits at its her-scaled centre", () => {
    for (const v of VOWELS) {
      const c = classifyVowel(scaledCentre(v), baseA);
      expect(c.vowel).toBe(v);
      expect(c.confidence).toBe(1); // exact: log(1)=0 → exp(0)=1 at the centre
    }
  });

  it("AC#2: scores[v] === vowelMatch(formants, v, baseline) for every vowel", () => {
    const f = scaledCentre("о");
    const c = classifyVowel(f, baseA);
    for (const v of VOWELS) {
      expect(c.scores[v]).toBe(vowelMatch(f, v, baseA));
    }
    // and confidence is exactly the winning (argmax) score.
    expect(c.confidence).toBe(c.scores[c.vowel!]);
    expect(c.confidence).toBe(Math.max(...VOWELS.map((v) => c.scores[v])));
  });

  it("AC#2: a real «о» frame reports «о», а «и» frame reports «и»", () => {
    expect(classifyVowel(CHILD.о, baseA).vowel).toBe("о");
    expect(classifyVowel(CHILD.и, baseA).vowel).toBe("и");
  });

  const NEUTRAL = { vowel: null, confidence: 0, scores: { а: 0, о: 0, у: 0, и: 0 } };

  it("AC#1: no usable baseline → null verdict, all-zero scores (never a 4-way 1-tie)", () => {
    expect(classifyVowel({ f1: 600, f2: 1200 }, null)).toEqual(NEUTRAL);
    expect(classifyVowel({ f1: 600, f2: 1200 }, { centroid: 1100 })).toEqual(NEUTRAL); // no f1/f2
    // half a baseline (only f1) is also "no opinion", like vowelMatch.
    expect(
      classifyVowel({ f1: 600, f2: 1200 }, { centroid: 1100, f1: baseA.f1 }),
    ).toEqual(NEUTRAL);
  });

  it("AC#1: a missing / zero / NaN estimate → null verdict, all-zero scores", () => {
    expect(classifyVowel({ f1: 0, f2: 0 }, baseA)).toEqual(NEUTRAL); // silence sentinel
    expect(classifyVowel({ f1: 600, f2: 0 }, baseA)).toEqual(NEUTRAL); // half estimate
    // `!(f > 0)` (not `f <= 0`) so a NaN formant also degrades to no opinion.
    expect(classifyVowel({ f1: NaN, f2: 1200 }, baseA)).toEqual(NEUTRAL);
    expect(classifyVowel({ f1: 600, f2: NaN }, baseA)).toEqual(NEUTRAL);
  });
});

// --- Rung 3 (#6): coarse consonant class ----------------------------------

/** Build a run of `n` identical release frames (voiced + zcr). */
function run(n: number, voiced: boolean, zcr = 0): ReleaseFrame[] {
  return Array.from({ length: n }, () => ({ voiced, zcr }));
}

describe("classifyConsonant (Rung 3, #6)", () => {
  const VOWEL_ZCR = 0.03; // tonal, low-ZCR (a vowel / sonorant)
  const HISS_ZCR = 0.45; // broadband hiss (a fricative)

  it("AC#1: a hold then a closure gap is a STOP", () => {
    // A sustained low-ZCR voiced run, then near-silence — «ооо» → «т» closure.
    const frames = [...run(12, true, VOWEL_ZCR), ...run(8, false)];
    expect(classifyConsonant(frames)).toBe("stop");
  });

  it("AC#1: a hold → closure → burst → silence is still a STOP (the «т» release)", () => {
    // The first closure is DELIBERATELY shorter than CONSONANT_GAP_FRAMES (2 < 3)
    // so it can't make a stop on its own; the burst then resets the closure count,
    // and ONLY the longer post-burst silence reaches the threshold. This forces
    // the `gap = 0` reset-on-burst branch to run (a 3-frame first closure would
    // short-circuit to "stop" before the burst, leaving that branch untested).
    const frames = [
      ...run(12, true, VOWEL_ZCR), // «ооо» hold
      ...run(2, false), // brief closure (< CONSONANT_GAP_FRAMES)
      ...run(1, true, HISS_ZCR), // «т» burst → resets the gap counter to 0
      ...run(4, false), // post-burst silence (>= CONSONANT_GAP_FRAMES) → STOP
    ];
    expect(classifyConsonant(frames)).toBe("stop");
  });

  it("AC#1: a continuous low-ZCR voiced hum with no gap is a SONORANT", () => {
    // A held «р»/«м» — vowel-like to Rung 1, but it never closes into a stop.
    expect(classifyConsonant(run(24, true, VOWEL_ZCR))).toBe("sonorant");
  });

  it("AC#1: a sustained high-ZCR hiss is a FRICATIVE (texture wins over a trailing gap)", () => {
    // «шшш»: voiced-above-floor but hiss-like throughout. Even with a closing
    // gap, the texture decides first — it is a fricative, not a stop.
    expect(classifyConsonant(run(20, true, HISS_ZCR))).toBe("fricative");
    expect(
      classifyConsonant([...run(12, true, HISS_ZCR), ...run(8, false)]),
    ).toBe("fricative");
  });

  it("the fricative knee is `>= 0.5`: exactly half hiss-voiced is a FRICATIVE, just under is not", () => {
    // Guards the comparator at CONSONANT_FRICATIVE_FRAC: an off-by-one flip of
    // `>=` to `>` would reclassify the exact-half case (a tie counts as fricative).
    const half = [...run(6, true, HISS_ZCR), ...run(6, true, VOWEL_ZCR)]; // 6/12 = 0.5
    expect(classifyConsonant(half)).toBe("fricative");
    const under = [...run(5, true, HISS_ZCR), ...run(7, true, VOWEL_ZCR)]; // 5/12 < 0.5
    expect(classifyConsonant(under)).toBe("sonorant"); // voiced throughout, no gap
  });

  it("the three classes are mutually separable on the same window length", () => {
    const stop = [...run(10, true, VOWEL_ZCR), ...run(8, false)];
    const sonorant = run(18, true, VOWEL_ZCR);
    const fricative = run(18, true, HISS_ZCR);
    const labels = [stop, sonorant, fricative].map((w) => classifyConsonant(w));
    expect(labels).toEqual(["stop", "sonorant", "fricative"]);
    expect(new Set(labels).size).toBe(3);
  });

  it("returns 'none' for silence or a lone click (too little signal)", () => {
    expect(classifyConsonant(run(20, false))).toBe("none"); // pure silence
    expect(classifyConsonant([])).toBe("none"); // empty window
    // A lone «т» click: one voiced frame, no sustained hold → not a stop/sonorant.
    expect(classifyConsonant([...run(2, false), ...run(1, true, HISS_ZCR), ...run(6, false)])).toBe("none");
  });

  it("returns 'none' for voicing too scattered to sustain (no real hold)", () => {
    // Voiced total ≥ minVoiced, but never 3 consecutive → not a hum, not a stop.
    const flicker: ReleaseFrame[] = [];
    for (let i = 0; i < 8; i++) flicker.push({ voiced: i % 2 === 0, zcr: VOWEL_ZCR });
    expect(classifyConsonant(flicker)).toBe("none");
  });

  it("a brief sub-threshold flicker after the hold is NOT a stop", () => {
    // A 2-frame dip (< CONSONANT_GAP_FRAMES) inside a hum doesn't close a stop.
    const frames = [...run(8, true, VOWEL_ZCR), ...run(2, false), ...run(8, true, VOWEL_ZCR)];
    expect(classifyConsonant(frames)).toBe("sonorant");
  });
});

// --- Rung 3 (#12): the fast «т» stop-burst detector over a canned envelope -----

describe("detectStopBurst (#12)", () => {
  const FLOOR = 0.01; // a calibrated noise floor
  const DT = 16; // ms/frame
  const VOWEL = 0.3; // a loud held-vowel envelope level
  const CLOSED = 0.005; // near-silence during the closure (< peak·dipFraction)

  /** Build a fast-envelope history: `pre` loud vowel frames, `closure` near-silent
   * frames, then the latest frame at `last`. Mirrors what the engine accumulates. */
  const env = (pre: number, closure: number, last: number): number[] => [
    ...Array(pre).fill(VOWEL),
    ...Array(closure).fill(CLOSED),
    last,
  ];

  it("AC#4: fires on a vowel → 50–150 ms closure → burst", () => {
    // 5-frame closure ≈ 80 ms, then a burst that rises back near the vowel level.
    expect(detectStopBurst(env(6, 5, VOWEL), FLOOR, DT)).toBe(true);
  });

  it("AC#4: does NOT fire on a sustained vowel (no closure, no dip)", () => {
    const sustained = Array(16).fill(VOWEL);
    expect(detectStopBurst(sustained, FLOOR, DT)).toBe(false);
  });

  it("AC#4: does NOT fire on a continuous hum that merely wobbles", () => {
    // Energy stays well above the dip throughout — no closure to release from.
    const hum = [0.3, 0.28, 0.31, 0.27, 0.3, 0.29, 0.3, 0.28, 0.3, 0.3];
    expect(detectStopBurst(hum, FLOOR, DT)).toBe(false);
  });

  it("does NOT fire on a plain run-out-of-breath (closure but no burst)", () => {
    // Vowel → closure → stays silent. The breath-stop gap path (matcher) handles
    // this at the easy end; the burst detector must stay quiet (AC#3 at strict).
    expect(detectStopBurst(env(6, 6, CLOSED), FLOOR, DT)).toBe(false);
  });

  it("does NOT fire when the closure is too short (a flicker)", () => {
    // 1-frame closure ≈ 16 ms < STOP_BURST_MIN_CLOSURE_MS.
    expect(detectStopBurst(env(8, 1, VOWEL), FLOOR, DT)).toBe(false);
  });

  it("does NOT fire when the closure is too long (a pause / new word)", () => {
    // A long silence then a fresh vowel is a restart, not a single «т» release.
    const tooLong = Math.ceil(STOP_BURST_MAX_CLOSURE_MS / DT) + 2;
    expect(detectStopBurst(env(4, tooLong, VOWEL), FLOOR, DT)).toBe(false);
  });

  it("does NOT fire with no preceding vowel (a lone burst from silence)", () => {
    // Closure with nothing loud before it → there is no held sound being released.
    const lone = [CLOSED, CLOSED, CLOSED, CLOSED, CLOSED, VOWEL];
    expect(detectStopBurst(lone, FLOOR, DT)).toBe(false);
  });

  it("is quiet when everything is near the noise floor (no real sound)", () => {
    const quiet = [0.008, 0.005, 0.006, 0.004, 0.005, 0.012];
    expect(detectStopBurst(quiet, FLOOR, DT)).toBe(false);
  });

  it("only fires on the rising EDGE, not while the burst is sustained", () => {
    // Frame after the burst: still loud, but its predecessor was already loud →
    // no fresh rising edge, so it is edge-triggered (one frame), not held.
    const afterEdge = [...Array(5).fill(VOWEL), CLOSED, CLOSED, CLOSED, VOWEL, VOWEL];
    expect(detectStopBurst(afterEdge, FLOOR, DT)).toBe(false);
  });
});
