import { describe, it, expect } from "vitest";
import { PatternMatcher } from "../src/game/PatternMatcher";
import type { AcousticPattern } from "../src/game/types";
import { makeFrame } from "./_helpers";

const PATTERN: AcousticPattern = {
  rung: 1,
  sustain: { minMs: 600, want: "vowel" },
  release: { requireGapMs: 120 },
};

const DT = 16; // ms per frame (~60fps)

/** Feed `count` identical frames; return the last MatchState. */
function feed(
  m: PatternMatcher,
  count: number,
  frameProps: Parameters<typeof makeFrame>[0],
) {
  let last = m.update(makeFrame(frameProps), DT);
  for (let i = 1; i < count; i++) last = m.update(makeFrame(frameProps), DT);
  return last;
}

describe("PatternMatcher", () => {
  it("a short vowel blip (<600ms) never arms the pounce (AC#2)", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    const held = feed(m, 18, { voiced: true, level: 0.6, vowelLikeness: 0.8 }); // ~288ms
    expect(held.holdSatisfied).toBe(false);

    let caughtEver = false;
    for (let i = 0; i < 20; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caughtEver = true;
    }
    expect(caughtEver).toBe(false);
  });

  it("a sustained vowel (>=600ms) then a stop arms and catches once (AC#3)", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    const held = feed(m, 45, { voiced: true, level: 0.7, vowelLikeness: 0.85 }); // ~720ms
    expect(held.holdSatisfied).toBe(true);

    let caught = 0;
    for (let i = 0; i < 12; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caught++;
    }
    expect(caught).toBe(1); // edge-triggered exactly once
  });

  it("a continuous noisy scream never satisfies the hold (AC#1)", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    let satEver = false;
    let caughtEver = false;
    for (let i = 0; i < 150; i++) {
      const r = m.update(
        makeFrame({ voiced: true, level: 0.9, vowelLikeness: 0.1, silenceMs: 0 }),
        DT,
      );
      if (r.holdSatisfied) satEver = true;
      if (r.caught) caughtEver = true;
    }
    expect(satEver).toBe(false);
    expect(caughtEver).toBe(false);
  });

  it("a held vowel with no stop never catches (a stop is required)", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    let satisfied = false;
    let caughtEver = false;
    for (let i = 0; i < 80; i++) {
      const r = m.update(
        makeFrame({ voiced: true, level: 0.8, vowelLikeness: 0.9, silenceMs: 0 }),
        DT,
      );
      satisfied = r.holdSatisfied;
      if (r.caught) caughtEver = true;
    }
    expect(satisfied).toBe(true);
    expect(caughtEver).toBe(false);
  });

  it("forgives a brief (<150ms) dropout in the middle of a hold", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    feed(m, 32, { voiced: true, level: 0.7, vowelLikeness: 0.8 }); // ~512ms (not yet satisfied)
    feed(m, 6, { voiced: false, silenceMs: 0 }); // ~96ms flicker, within grace
    const held = feed(m, 14, { voiced: true, level: 0.7, vowelLikeness: 0.8 }); // +224ms
    expect(held.holdSatisfied).toBe(true); // 512 + 224 carried across the gap
  });

  it("resets the hold after a long (>150ms) dropout", () => {
    const m = new PatternMatcher(PATTERN, { assist: 0 });
    feed(m, 32, { voiced: true, level: 0.7, vowelLikeness: 0.8 }); // ~512ms
    feed(m, 13, { voiced: false, silenceMs: 0 }); // ~208ms break, past grace → reset
    const held = feed(m, 14, { voiced: true, level: 0.7, vowelLikeness: 0.8 }); // only +224ms
    expect(held.holdSatisfied).toBe(false);
  });

  it("assist relaxes the gate: a borderline sound holds only when eased", () => {
    const run = (assist: number) => {
      const m = new PatternMatcher(PATTERN, { assist });
      // 0.3 is below the strict 0.4 threshold; 400ms is below the strict 600ms.
      return feed(m, 25, { voiced: true, level: 0.5, vowelLikeness: 0.3 }).holdSatisfied;
    };
    expect(run(0)).toBe(false); // strict: never counts as holding
    expect(run(1)).toBe(true); // easy: threshold + min-hold relaxed enough
  });

  it("AC#3: rung1 gates the vowel grading (off → loudness-only hold)", () => {
    // A loud but noisy sound (low vowel-likeness): with Rung 1 ON it never
    // satisfies the vowel hold; with Rung 1 OFF the gate is loudness-only, so any
    // sustained voicing counts — exactly the pre-#1 (Rung 0) behavior.
    const noisy = { voiced: true, level: 0.7, vowelLikeness: 0.1, silenceMs: 0 };
    const rung1On = feed(new PatternMatcher(PATTERN, { assist: 0, rung1: true }), 60, noisy);
    const rung1Off = feed(new PatternMatcher(PATTERN, { assist: 0, rung1: false }), 60, noisy);
    expect(rung1On.holdSatisfied).toBe(false);
    expect(rung1Off.holdSatisfied).toBe(true);
  });

  it("rung1 defaults on, preserving the shipped Rung-1 behavior", () => {
    // No `rung1` option → vowel grading, same as Increment 1.
    const noisy = { voiced: true, level: 0.9, vowelLikeness: 0.1, silenceMs: 0 };
    expect(feed(new PatternMatcher(PATTERN, { assist: 0 }), 60, noisy).holdSatisfied).toBe(false);
  });
});
