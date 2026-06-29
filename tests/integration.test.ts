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
