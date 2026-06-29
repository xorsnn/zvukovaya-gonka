import { describe, it, expect } from "vitest";
import {
  zeroCrossingRate,
  spectralFlatness,
  spectralCentroid,
  lowBandRatio,
  vowelLikeness,
} from "../src/audio/PhoneticFeatures";
import { sineTime, noiseTime } from "./_helpers";

const SR = 44100;
const N = 512; // frequencyBinCount for fftSize 1024

/** A linear-magnitude spectrum with a single bin of energy. */
function magWithPeak(bin: number, n = N): Float32Array {
  const a = new Float32Array(n);
  a[bin] = 1;
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
