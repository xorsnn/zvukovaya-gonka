import { describe, it, expect } from "vitest";
import { PatternMatcher, VOWEL_MATCH_FLOOR } from "../src/game/PatternMatcher";
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

// --- Rung 2 (#5): vowel identity, folded into drive as a graded factor -----

// An «о» scene (e.g. «кот»), and her calibration vowel «а» anchoring her space.
const O_PATTERN: AcousticPattern = { ...PATTERN, vowel: "о" };
const BASE_A = { centroid: 1100, f1: 850, f2: 1400 };
// Frames for a held «о» vs a held «а» at equal loudness + vowel-likeness; they
// differ ONLY in their formants (which vowel she's actually making).
const HELD_O = { voiced: true, level: 1, vowelLikeness: 0.8, f1: 560, f2: 950 };
const HELD_A = { voiced: true, level: 1, vowelLikeness: 0.8, f1: 850, f2: 1400 };

describe("PatternMatcher — Rung 2 vowel identity (#5)", () => {
  it("invariant #1: rung2 OFF → drive is byte-identical to Rung 1 (parity)", () => {
    const off = new PatternMatcher(O_PATTERN, { assist: 0, vowelBaseline: BASE_A }).update(
      makeFrame(HELD_O),
      DT,
    );
    const rung1Only = new PatternMatcher(PATTERN, { assist: 0 }).update(makeFrame(HELD_O), DT);
    expect(off.driveQuality).toBe(rung1Only.driveQuality);
    expect(off.vowelMatch).toBe(1); // no opinion when rung2 is off
  });

  it("AC#2 / invariant #3: held «о» drives faster than «а», but «а» still moves clearly", () => {
    const mk = (f: Parameters<typeof makeFrame>[0]) =>
      new PatternMatcher(O_PATTERN, { assist: 0, rung2: true, vowelBaseline: BASE_A }).update(
        makeFrame(f),
        DT,
      );
    const o = mk(HELD_O);
    const a = mk(HELD_A);
    expect(o.driveQuality).toBeGreaterThan(a.driveQuality); // «о» is faster
    expect(o.driveQuality / a.driveQuality).toBeGreaterThanOrEqual(1.15); // measurably so
    expect(a.driveQuality).toBeGreaterThan(0.5); // wrong vowel still well above MIN_FLOOR
    expect(o.vowelMatch).toBeGreaterThan(a.vowelMatch);
  });

  it("invariant #2: rung2 NEVER gates — a 'wrong' vowel still holds and catches", () => {
    const m = new PatternMatcher(O_PATTERN, { assist: 0, rung2: true, vowelBaseline: BASE_A });
    // Hold the WRONG vowel («а» on an «о» scene) for ~720ms.
    const held = feed(m, 45, HELD_A);
    expect(held.holdSatisfied).toBe(true); // hold is pure Rung-1 — vowel id can't block it

    let caught = 0;
    for (let i = 0; i < 12; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caught++;
    }
    expect(caught).toBe(1); // the stop still catches, wrong vowel and all
  });

  it("invariant #4: assist → 1 makes vowel identity irrelevant (back to Rung-1 feel)", () => {
    const mk = (f: Parameters<typeof makeFrame>[0]) =>
      new PatternMatcher(O_PATTERN, { assist: 1, rung2: true, vowelBaseline: BASE_A }).update(
        makeFrame(f),
        DT,
      ).driveQuality;
    expect(Math.abs(mk(HELD_O) - mk(HELD_A))).toBeLessThan(1e-9);
  });

  it("degrades to neutral (match 1, Rung-1 drive) with no baseline", () => {
    const r = new PatternMatcher(O_PATTERN, { assist: 0, rung2: true }).update(makeFrame(HELD_O), DT);
    const ref = new PatternMatcher(PATTERN, { assist: 0 }).update(makeFrame(HELD_O), DT);
    expect(r.vowelMatch).toBe(1);
    expect(r.driveQuality).toBe(ref.driveQuality);
  });

  it("degrades to neutral when the scene has no target vowel", () => {
    const r = new PatternMatcher(PATTERN, { assist: 0, rung2: true, vowelBaseline: BASE_A }).update(
      makeFrame(HELD_O),
      DT,
    );
    expect(r.vowelMatch).toBe(1);
  });

  it("invariant #3 (floor): a maximally-wrong vowel still keeps VOWEL_MATCH_FLOOR of the drive", () => {
    // «и» scene, but she makes a low-back «у»-ish sound → vowelMatch ≈ 0. The
    // bounded floor is the guarantee that even a total mismatch never punishes
    // the chase below VOWEL_MATCH_FLOOR·quality (a regression that dropped the
    // floor toward 0 would otherwise pass the rest of the suite).
    const I_PATTERN: AcousticPattern = { ...PATTERN, vowel: "и" };
    const WAY_OFF = { voiced: true, level: 1, vowelLikeness: 0.8, f1: 300, f2: 700 };
    const r = new PatternMatcher(I_PATTERN, { assist: 0, rung2: true, vowelBaseline: BASE_A }).update(
      makeFrame(WAY_OFF),
      DT,
    );
    expect(r.vowelMatch).toBeLessThan(0.15); // genuinely the wrong vowel
    const quality = 0.8 * 1; // effVowel(0.8 @ assist 0) × level
    expect(r.driveQuality).toBeGreaterThanOrEqual(VOWEL_MATCH_FLOOR * quality - 1e-9);
  });
});

// --- Rung 3 (#6): consonant class & the real «т» stop ----------------------

// «кот»: a vowel hold then a genuine «т» stop. Same shape as PATTERN, but the
// release asks for a stop, which is what unlocks Rung 3's burst-catch.
const STOP_PATTERN: AcousticPattern = {
  ...PATTERN,
  release: { requireGapMs: 120, want: "stop" },
};
const HOLD = { voiced: true, level: 0.8, vowelLikeness: 0.85, zcr: 0.03 };

describe("PatternMatcher — Rung 3 stop (#6)", () => {
  it("AC#4: rung3 OFF → no consonant label and no early burst-catch (parity)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0 }); // rung3 defaults off
    const held = feed(m, 45, HOLD);
    expect(held.holdSatisfied).toBe(true);
    expect(held.consonantClass).toBe("none");
    expect(held.burstDetected).toBe(false);
    // A brief closure (< full gap) then a burst onset must NOT catch with rung3
    // off — only the plain gap path exists, exactly like today.
    m.update(makeFrame({ voiced: false, silenceMs: 64 }), DT);
    const r = m.update(makeFrame({ voiced: true, onset: true, silenceMs: 0 }), DT);
    expect(r.caught).toBe(false);
    expect(r.burstDetected).toBe(false);
  });

  it("AC#2: a lone «т» (short, noisy) never arms or catches, even on a stop scene", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    // ~96 ms of a brief noisy burst — neither long enough nor vowel-like.
    let satEver = false;
    let caughtEver = false;
    for (let i = 0; i < 6; i++) {
      const r = m.update(makeFrame({ voiced: true, level: 0.7, vowelLikeness: 0.1, zcr: 0.45 }), DT);
      if (r.holdSatisfied) satEver = true;
      if (r.caught) caughtEver = true;
    }
    for (let i = 0; i < 12; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caughtEver = true;
    }
    expect(satEver).toBe(false); // the hold is never satisfied by a lone «т»
    expect(caughtEver).toBe(false);
  });

  it("AC#3 / leniency #2: a held vowel then just running out of breath still catches", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    const held = feed(m, 45, HOLD);
    expect(held.holdSatisfied).toBe(true);
    // Gap only — no burst. The closure alone must still finish the catch.
    let caught = 0;
    let burstSeen = false;
    for (let i = 0; i < 12; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caught++;
      if (r.burstDetected) burstSeen = true;
    }
    expect(caught).toBe(1); // gap-only still wins (leniency)
    expect(burstSeen).toBe(false); // and it was NOT via a burst
  });

  it("a crisp «т» (closure then a burst) catches on the burst — a bonus path", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(m, 45, HOLD);
    // A brief closure under the full gap, so only the burst can fire the catch.
    m.update(makeFrame({ voiced: false, silenceMs: 32 }), DT); // < MIN_CLOSURE, no arm
    m.update(makeFrame({ voiced: false, silenceMs: 64 }), DT); // ≥ MIN_CLOSURE → armed
    const r = m.update(makeFrame({ voiced: true, onset: true, silenceMs: 0 }), DT);
    expect(r.burstDetected).toBe(true);
    expect(r.caught).toBe(true); // the «т» release completed the stop early
  });

  it("AC#3: a continuous «р» hum (no stop) holds but NEVER catches", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    let satEver = false;
    let caughtEver = false;
    let last = m.update(makeFrame(HOLD), DT);
    for (let i = 0; i < 150; i++) {
      last = m.update(makeFrame({ ...HOLD, silenceMs: 0 }), DT);
      if (last.holdSatisfied) satEver = true;
      if (last.caught) caughtEver = true;
    }
    expect(satEver).toBe(true); // a sustained hum reads vowel-like → it holds
    expect(caughtEver).toBe(false); // but with no closure it never catches
    expect(last.consonantClass).toBe("sonorant"); // and it's labelled a hum
  });

  it("labels the release: a hold reads 'sonorant', a hold+closure reads 'stop'", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    const held = feed(m, 45, HOLD);
    expect(held.consonantClass).toBe("sonorant"); // sustained voiced, no gap yet
    let last = held;
    for (let i = 0; i < 10; i++) {
      last = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
    }
    expect(last.consonantClass).toBe("stop"); // the closure makes it a stop
  });

  it("a 'wrong' consonant class never blocks the catch (graded, never gated)", () => {
    // Even if the hold tail were hiss-y (the classifier might say 'fricative'),
    // the gap-only catch still fires — Rung 3 only ADDS a burst path, it never
    // withholds the catch from a real hold + stop.
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(m, 45, { voiced: true, level: 0.8, vowelLikeness: 0.85, zcr: 0.4 });
    let caught = 0;
    for (let i = 0; i < 12; i++) {
      const r = m.update(makeFrame({ voiced: false, silenceMs: (i + 1) * DT }), DT);
      if (r.caught) caught++;
    }
    expect(caught).toBe(1);
  });
});
