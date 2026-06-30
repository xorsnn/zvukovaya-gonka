import { describe, it, expect } from "vitest";
import { AudioEngine } from "../src/audio/AudioEngine";
import { PatternMatcher } from "../src/game/PatternMatcher";
import type { AcousticPattern } from "../src/game/types";
import {
  FakeAnalyser,
  sineTime,
  noiseTime,
  tonalSpectrumDb,
  flatSpectrumDb,
  silentSpectrumDb,
  vowelSpectrumDb,
} from "./_helpers";

const PATTERN: AcousticPattern = {
  rung: 1,
  sustain: { minMs: 600, want: "vowel" },
  release: { requireGapMs: 120 },
};

const SR = 44100;
const STEP = 16; // ms/frame

/**
 * Drive a canned sound through the *real* AudioEngine (spectral analysis, noise
 * floor, voiced hysteresis) and the *real* PatternMatcher, the way the game does
 * each frame. Returns whether the hold satisfied and whether the catch fired.
 */
function runScenario(
  hold: { time: Float32Array; freqDb: Float32Array },
  holdFrames: number,
  gapFrames: number,
): { holdSatisfied: boolean; caught: boolean } {
  const analyser = new FakeAnalyser();
  const engine = new AudioEngine({ analyser, sampleRate: SR });
  const matcher = new PatternMatcher(PATTERN, { assist: 0 });

  let t = 0;
  let holdSatisfied = false;
  let caught = false;

  // 1) ambient quiet so the noise floor calibrates low (~1.5s of silence).
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }

  // 2) the held sound.
  analyser.time = hold.time;
  analyser.freqDb = hold.freqDb;
  for (let i = 0; i < holdFrames; i++) {
    const m = matcher.update(engine.sample(t), STEP);
    if (m.holdSatisfied) holdSatisfied = true;
    if (m.caught) caught = true;
    t += STEP;
  }

  // 3) the stop (silence) — long enough for the smoothed RMS to fall and the gap
  //    to be recognised.
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < gapFrames; i++) {
    const m = matcher.update(engine.sample(t), STEP);
    if (m.caught) caught = true;
    t += STEP;
  }

  return { holdSatisfied, caught };
}

describe("AudioEngine → PatternMatcher integration", () => {
  it("«о-о-о» (≈300 Hz) held then stopped catches the mouse (AC#3)", () => {
    const r = runScenario(
      { time: sineTime(300, 0.3), freqDb: tonalSpectrumDb(7) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("«а-а-а» (≈440 Hz) held then stopped also catches", () => {
    const r = runScenario(
      { time: sineTime(440, 0.3), freqDb: tonalSpectrumDb(10) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("a continuous shriek then a stop never catches (AC#1)", () => {
    const r = runScenario(
      { time: noiseTime(0.3), freqDb: flatSpectrumDb(-40) },
      60,
      60,
    );
    expect(r.holdSatisfied).toBe(false);
    expect(r.caught).toBe(false);
  });

  it("a short shout (<600ms) then a stop never arms the pounce (AC#2)", () => {
    const r = runScenario(
      { time: sineTime(300, 0.3), freqDb: tonalSpectrumDb(7) },
      18,
      60,
    );
    expect(r.holdSatisfied).toBe(false);
    expect(r.caught).toBe(false);
  });
});

// --- Rung 2 (#5): canned «о» vs «а» through the REAL engine + matcher --------

const O_PATTERN: AcousticPattern = { ...PATTERN, vowel: "о" };
// Her calibration vowel «а» (high, child-ish formants) anchors her vowel space.
const BASE_A = { centroid: 1100, f1: 850, f2: 1400 };
// Equal loudness (same sine amplitude → same RMS), differing only in formants.
const HELD_O = { time: sineTime(280, 0.3), freqDb: vowelSpectrumDb(560, 950) };
const HELD_A = { time: sineTime(440, 0.3), freqDb: vowelSpectrumDb(850, 1400) };

/**
 * Drive a held vowel through the real AudioEngine (which estimates F1/F2) into a
 * real matcher, and return the settled chase-drive after the hold. Ambient quiet
 * first, so the noise floor + level scaling match between runs.
 */
function settledDrive(
  hold: { time: Float32Array; freqDb: Float32Array },
  opts: ConstructorParameters<typeof PatternMatcher>[1],
  holdFrames = 40,
): number {
  const analyser = new FakeAnalyser();
  const engine = new AudioEngine({ analyser, sampleRate: SR });
  const matcher = new PatternMatcher(O_PATTERN, opts);
  let t = 0;
  analyser.time = new Float32Array(1024);
  analyser.freqDb = silentSpectrumDb();
  for (let i = 0; i < 90; i++) {
    engine.sample(t);
    t += STEP;
  }
  analyser.time = hold.time;
  analyser.freqDb = hold.freqDb;
  let drive = 0;
  for (let i = 0; i < holdFrames; i++) {
    drive = matcher.update(engine.sample(t), STEP).driveQuality;
    t += STEP;
  }
  return drive;
}

describe("AudioEngine → PatternMatcher Rung 2 integration (#5)", () => {
  it("AC#2: a held «о» drives faster than «а», both non-zero, gap exceeds Rung 1's", () => {
    const on = { assist: 0, rung2: true, vowelBaseline: BASE_A };
    const off = { assist: 0 }; // rung2 off → Rung 1
    const oOn = settledDrive(HELD_O, on);
    const aOn = settledDrive(HELD_A, on);
    const oOff = settledDrive(HELD_O, off);
    const aOff = settledDrive(HELD_A, off);

    expect(oOn).toBeGreaterThan(aOn); // «о» is faster
    expect(aOn).toBeGreaterThan(0); // but «а» still clearly moves (leniency)
    // Rung 2 ADDS vowel-identity separation on top of the Rung-1 vowelLikeness gap.
    expect(oOn - aOn).toBeGreaterThan(oOff - aOff);
  });
});
