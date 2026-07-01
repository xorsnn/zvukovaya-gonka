import { describe, it, expect } from "vitest";
import { stepPlay, strictnessFor, MOUSE_FLEE_RATE } from "../src/game/GameView";
import { PatternMatcher } from "../src/game/PatternMatcher";
import { WORDS } from "../src/game/words";
import type { AcousticPattern } from "../src/game/types";
import type { MatchState } from "../src/game/PatternMatcher";
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

    // Even with a non-zero strictness argument, match=null forces the easy/loudness
    // path (no flee) — the kill-switch can't be made harder by the slider.
    let pNew = 0.78; // seeded just below POUNCE_READY so the pounce gate is exercised
    let pOld = 0.78;
    for (const { f, en } of seq) {
      const a = stepPlay(pNew, f, dts, null, en, 1 /* strict, but ignored */);
      const b = oldStep(pOld, f, dts, en);
      expect(a).toEqual(b);
      pNew = a.progress;
      pOld = b.progress;
    }
  });
});

// --- Tug-of-war drive: the mouse flees, scaled by strictness (#12) -----------

describe("tug-of-war drive (#12)", () => {
  const DT = 0.016; // s/frame
  const mk = (p: Partial<MatchState>): MatchState => ({
    driveQuality: 0,
    holdSatisfied: false,
    caught: false,
    sustainHeldMs: 0,
    vowelMatch: 1,
    consonantClass: "none",
    burstDetected: false,
    armedForBurst: false,
    ...p,
  });

  it("AC#1: at easy (strictness 0) progress NEVER decays — silence holds it", () => {
    // A right vowel climbs, then silence: with no flee, progress is monotonic
    // exactly as today (leniency preserved as the easy default).
    let p = 0;
    for (let i = 0; i < 20; i++) {
      p = stepPlay(p, makeFrame({ voiced: true, level: 0.8 }), DT, mk({ driveQuality: 0.7 }), true, 0).progress;
    }
    const afterHold = p;
    expect(afterHold).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) {
      const next = stepPlay(p, makeFrame({ voiced: false }), DT, mk({ driveQuality: 0 }), true, 0).progress;
      expect(next).toBeGreaterThanOrEqual(p); // never goes backward at easy
      p = next;
    }
    expect(p).toBe(afterHold); // silence at easy is a no-op
  });

  it("AC#2: at strict (strictness 1) a sustained RIGHT vowel makes the cat gain", () => {
    let p = 0.2;
    for (let i = 0; i < 10; i++) {
      const next = stepPlay(p, makeFrame({ voiced: true, level: 0.9 }), DT, mk({ driveQuality: 0.75 }), true, 1).progress;
      expect(next).toBeGreaterThan(p); // right vowel out-drives the flee
      p = next;
    }
  });

  it("AC#2: at strict, sustained WRONG input returns progress to 0", () => {
    // A loud-but-low-quality (wrong) sound: its drive sits below the flee, so the
    // mouse gains and progress decays all the way to 0 (clamped, never negative).
    let p = 0.7;
    for (let i = 0; i < 300; i++) {
      p = stepPlay(p, makeFrame({ voiced: true, level: 0.5 }), DT, mk({ driveQuality: 0.05 }), true, 1).progress;
    }
    expect(p).toBe(0);
  });

  it("AC#2: at strict, SILENCE makes the mouse gain (progress decays to 0)", () => {
    let p = 0.6;
    let everIncreased = false;
    for (let i = 0; i < 200; i++) {
      const next = stepPlay(p, makeFrame({ voiced: false }), DT, mk({ driveQuality: 0 }), true, 1).progress;
      if (next > p) everIncreased = true;
      p = next;
    }
    expect(everIncreased).toBe(false);
    expect(p).toBe(0); // escaped back to the start, clamped at 0
  });

  it("AC#2: at strict, the hold-surge no longer floors progress through silence", () => {
    // holdSatisfied but silent: at easy the surge would pull the cat in; at strict
    // the mouse is allowed to gain instead, so progress falls.
    const start = 0.5;
    const strict = stepPlay(start, makeFrame({ voiced: false }), DT, mk({ holdSatisfied: true }), true, 1).progress;
    const easy = stepPlay(start, makeFrame({ voiced: false }), DT, mk({ holdSatisfied: true }), true, 0).progress;
    expect(strict).toBeLessThan(start); // mouse gained
    expect(easy).toBeGreaterThan(start); // cat closed in (today's surge)
  });

  it("the flee rate scales continuously with strictness (mid is between the ends)", () => {
    const f = (s: number) =>
      stepPlay(0.6, makeFrame({ voiced: false }), DT, mk({ driveQuality: 0 }), true, s).progress;
    const easy = f(0);
    const mid = f(0.5);
    const strict = f(1);
    expect(easy).toBe(0.6); // no flee
    expect(strict).toBeCloseTo(0.6 - MOUSE_FLEE_RATE * DT, 6); // full flee
    expect(mid).toBeGreaterThan(strict);
    expect(mid).toBeLessThan(easy); // a real, partial tug-of-war in between
  });
});

// --- #18: forward-only approach on a stop scene (strictnessFor) --------------

describe("strictnessFor (#18)", () => {
  const kot = WORDS.find((w) => w.id === "kot")!; // chase + «т» stop
  const vot = WORDS.find((w) => w.id === "vot")!; // pull + «т» stop
  const dom = WORDS.find((w) => w.id === "dom")!; // chase, non-stop («М»)

  it("AC#6: a stop scene is forward-only (strictness 0) at EVERY assist", () => {
    for (const assist of [0, 0.25, 0.5, 0.75, 1]) {
      expect(strictnessFor(kot, assist)).toBe(0);
      expect(strictnessFor(vot, assist)).toBe(0); // the pull mode too
    }
  });

  it("a non-stop scene keeps the #12 tug-of-war (strictness = 1 - assist)", () => {
    expect(strictnessFor(dom, 0)).toBe(1);
    expect(strictnessFor(dom, 0.5)).toBe(0.5);
    expect(strictnessFor(dom, 1)).toBe(0);
  });

  it("forward-only means the actor never drifts backward: stepPlay with strictness 0 is monotonic", () => {
    // strictnessFor(kot, …) = 0, so stepPlay runs its easy trajectory — silence is
    // a no-op, never a regression (the actor parks at the checkpoint).
    const s = strictnessFor(kot, 0);
    let p = 0.5;
    for (let i = 0; i < 40; i++) {
      const next = stepPlay(p, makeFrame({ voiced: false }), 0.016, mkMin(), true, s).progress;
      expect(next).toBeGreaterThanOrEqual(p);
      p = next;
    }
  });
});

/** A minimal MatchState (armed, silent) for the forward-only monotonicity check. */
function mkMin(): MatchState {
  return {
    driveQuality: 0,
    holdSatisfied: true,
    caught: false,
    sustainHeldMs: 600,
    vowelMatch: 1,
    consonantClass: "none",
    burstDetected: false,
    armedForBurst: true,
  };
}
