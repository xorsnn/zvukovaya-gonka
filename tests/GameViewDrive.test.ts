import { describe, it, expect } from "vitest";
import { stepPlay } from "../src/game/GameView";
import { PatternMatcher } from "../src/game/PatternMatcher";
import type { AcousticPattern } from "../src/game/types";
import { makeFrame } from "./_helpers";

const PATTERN: AcousticPattern = {
  rung: 1,
  sustain: { minMs: 600, want: "vowel" },
  release: { requireGapMs: 120 },
};

describe("chase drive (phonetic path)", () => {
  it("AC#4: a clear vowel drives ≥2× a noisy sound, and the noisy sound still moves", () => {
    const dts = 0.05;
    const drivingFrame = makeFrame({ voiced: true, level: 1.0 });

    // Same loudness, different vowel-likeness → different driveQuality (assist 0 = strict).
    const clear = new PatternMatcher(PATTERN, { assist: 0 }).update(
      makeFrame({ voiced: true, level: 1.0, vowelLikeness: 0.8 }),
      16,
    );
    const noisy = new PatternMatcher(PATTERN, { assist: 0 }).update(
      makeFrame({ voiced: true, level: 1.0, vowelLikeness: 0.3 }),
      16,
    );

    const clearPPS = stepPlay(0, drivingFrame, dts, clear, true).progress / dts;
    const noisyPPS = stepPlay(0, drivingFrame, dts, noisy, true).progress / dts;

    expect(clearPPS / noisyPPS).toBeGreaterThanOrEqual(2); // visibly faster
    expect(noisyPPS).toBeGreaterThan(0); // leniency invariant #1: still moves
  });

  it("leniency invariant #1: genuine voicing never yields zero drive", () => {
    // Even a worst-case vowel-likeness of 0 still advances on voiced input.
    const zeroQuality = { driveQuality: 0, holdSatisfied: false, caught: false, sustainHeldMs: 0 };
    const step = stepPlay(0, makeFrame({ voiced: true, level: 0.5 }), 0.05, zeroQuality, true);
    expect(step.progress).toBeGreaterThan(0);
  });

  it("AC#3: a satisfied hold then a stop catches even from low chase progress", () => {
    // A quiet 600ms hold only nudges `progress` to ~0.4; the catch must NOT
    // depend on reaching POUNCE_READY (caught is a one-shot edge that would
    // otherwise be lost). The cat closes in on holdSatisfied, then the stop wins.
    const dts = 0.05;
    const holding = { driveQuality: 0.3, holdSatisfied: true, caught: false, sustainHeldMs: 600 };
    const stopped = { driveQuality: 0, holdSatisfied: true, caught: true, sustainHeldMs: 600 };

    let p = 0.2; // deliberately far from POUNCE_READY
    for (let i = 0; i < 6; i++) {
      p = stepPlay(p, makeFrame({ voiced: true, level: 0.4 }), dts, holding, true).progress;
    }
    expect(p).toBeGreaterThan(0.8); // cat closed in and is poised behind the mouse

    const stop = stepPlay(p, makeFrame({ voiced: false }), dts, stopped, true);
    expect(stop.pounce).toBe(true);
  });
});

describe("USE_PHONETIC kill-switch identity (AC#5)", () => {
  // The exact pre-#1 loudness-only play step, inlined as the reference oracle.
  function oldStep(
    prev: number,
    frame: ReturnType<typeof makeFrame>,
    dts: number,
    inputEnabled: boolean,
  ) {
    let progress = prev;
    if (inputEnabled && frame.voiced) {
      const drive = Math.max(0.25, frame.level); // MIN_VOICED_DRIVE
      progress = Math.min(0.9, prev + drive * 1.0 * dts); // PRECHASE_CAP, CHASE_RATE
    }
    let pounce = false;
    if (inputEnabled && progress >= 0.8) pounce = frame.onset || frame.release; // POUNCE_READY
    return { progress, pounce };
  }

  it("stepPlay(match=null) reproduces the loudness-only trajectory byte-for-byte", () => {
    const dts = 0.05;
    const seq: Array<{ f: ReturnType<typeof makeFrame>; en: boolean }> = [
      { f: makeFrame({ voiced: true, level: 0.5 }), en: true },
      { f: makeFrame({ voiced: true, level: 1.0, onset: true }), en: true }, // crosses POUNCE_READY
      { f: makeFrame({ voiced: true, level: 1.0 }), en: false }, // input gated off
      { f: makeFrame({ voiced: false, level: 0, release: true }), en: true }, // release → pounce
      { f: makeFrame({ voiced: true, level: 1.0 }), en: true },
      { f: makeFrame({ voiced: true, level: 0.2 }), en: true }, // MIN_VOICED_DRIVE floor
    ];

    let pNew = 0.78; // seeded just below POUNCE_READY so the pounce gate is exercised
    let pOld = 0.78;
    for (const { f, en } of seq) {
      const a = stepPlay(pNew, f, dts, null, en);
      const b = oldStep(pOld, f, dts, en);
      expect(a).toEqual(b);
      pNew = a.progress;
      pOld = b.progress;
    }
  });
});
