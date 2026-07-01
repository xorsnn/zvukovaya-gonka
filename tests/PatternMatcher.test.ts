import { describe, it, expect } from "vitest";
import {
  PatternMatcher,
  VOWEL_MATCH_FLOOR,
  VOWEL_MATCH_FLOOR_STRICT,
  armedBurst,
  ARMED_BURST_VOWEL_FLOOR,
} from "../src/game/PatternMatcher";
import { ZCR_HIGH } from "../src/audio/PhoneticFeatures";
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

  it("AC#2 / invariant #3: held «о» drives faster than «а», and «а» still moves", () => {
    const mk = (f: Parameters<typeof makeFrame>[0]) =>
      new PatternMatcher(O_PATTERN, { assist: 0, rung2: true, vowelBaseline: BASE_A }).update(
        makeFrame(f),
        DT,
      );
    const o = mk(HELD_O);
    const a = mk(HELD_A);
    expect(o.driveQuality).toBeGreaterThan(a.driveQuality); // «о» is faster
    expect(o.driveQuality / a.driveQuality).toBeGreaterThanOrEqual(1.15); // measurably so
    // At strict (#12) the wrong vowel is slowed, but the cat's FORWARD drive is
    // still positive — any net regression comes from the GameView mouse-flee, not
    // from a zeroed drive here (leniency is now assist-scaled, not absolute).
    expect(a.driveQuality).toBeGreaterThan(0);
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

  it("invariant #3 (#12): the wrong-vowel floor is ASSIST-SCALED — relaxed at strict, preserved at easy", () => {
    // «и» scene, but she makes a low-back «у»-ish sound → vowelMatch ≈ 0.
    const I_PATTERN: AcousticPattern = { ...PATTERN, vowel: "и" };
    const WAY_OFF = { voiced: true, level: 1, vowelLikeness: 0.8, f1: 300, f2: 700 };
    const drive = (assist: number) =>
      new PatternMatcher(I_PATTERN, { assist, rung2: true, vowelBaseline: BASE_A }).update(
        makeFrame(WAY_OFF),
        DT,
      );

    const strict = drive(0);
    expect(strict.vowelMatch).toBeLessThan(0.15); // genuinely the wrong vowel
    const quality = 0.8 * 1; // effVowel(0.8 @ assist 0) × level
    // At strict the floor relaxes to VOWEL_MATCH_FLOOR_STRICT: the wrong vowel
    // drives BELOW the old easy floor (so the mouse-flee can net it negative — the
    // #12 tug-of-war), but it is still a positive forward floor, never zero.
    expect(strict.driveQuality).toBeGreaterThan(0);
    expect(strict.driveQuality).toBeLessThan(VOWEL_MATCH_FLOOR * quality);
    expect(strict.driveQuality).toBeGreaterThanOrEqual(VOWEL_MATCH_FLOOR_STRICT * quality - 1e-9);

    // At the easy end the wrong vowel keeps the FULL drive (leniency preserved):
    // assist→1 lifts the match to 1, so vowel identity stops mattering, exactly as
    // the rung2-off Rung-1 reference.
    const easy = drive(1);
    const ref = new PatternMatcher(PATTERN, { assist: 1 }).update(makeFrame(WAY_OFF), DT);
    expect(easy.driveQuality).toBeCloseTo(ref.driveQuality, 9);
  });
});

// --- Rung 3 (#6/#12): consonant class & the real «т» stop-burst -------------

// «кот»: a vowel hold then a genuine «т» stop. Same shape as PATTERN, but the
// release asks for a stop, which is what makes the «т» burst-catch and the
// strict consonant-gate apply.
const STOP_PATTERN: AcousticPattern = {
  ...PATTERN,
  release: { requireGapMs: 120, want: "stop", letter: "Т" },
};
const HOLD = { voiced: true, level: 0.8, vowelLikeness: 0.85, zcr: 0.03 };
// A real «т» burst frame, as the engine would surface it (fast-envelope detector).
const BURST = { voiced: true, level: 0.6, silenceMs: 0, stopBurst: true };
// A silence frame past the effective gap (the run-out-of-breath finale).
const gapFrame = (i: number) => makeFrame({ voiced: false, silenceMs: (i + 1) * DT });

describe("PatternMatcher — Rung 3 stop (#6/#12)", () => {
  it("AC#4: rung3 OFF → no consonant label, and a stopBurst is ignored (parity)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0 }); // rung3 defaults off
    const held = feed(m, 45, HOLD);
    expect(held.holdSatisfied).toBe(true);
    expect(held.consonantClass).toBe("none");
    expect(held.burstDetected).toBe(false);
    // A stopBurst frame must NOT catch with rung3 off — only the plain gap path
    // exists, exactly like today. (And at assist 0 a "stop" scene needs the burst,
    // but with rung3 off there is no stop scene to gate, so the gap still rules.)
    const r = m.update(makeFrame(BURST), DT);
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
    // Even a stopBurst can't catch without a satisfied hold first.
    const r = m.update(makeFrame(BURST), DT);
    if (r.caught) caughtEver = true;
    expect(satEver).toBe(false); // the hold is never satisfied by a lone «т»
    expect(caughtEver).toBe(false);
  });

  it("AC#3: at STRICT a real «т» burst catches; a gap (run out of breath) does NOT", () => {
    // On a stop scene the «т» burst is required and the breath-stop never wins —
    // now true at every assist (#18); this checks the строго end specifically.
    const burstM = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    expect(feed(burstM, 45, HOLD).holdSatisfied).toBe(true);
    const r = burstM.update(makeFrame(BURST), DT);
    expect(r.burstDetected).toBe(true);
    expect(r.caught).toBe(true); // the «т» release wins

    const gapM = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(gapM, 45, HOLD);
    let gapCaught = 0;
    for (let i = 0; i < 20; i++) if (gapM.update(gapFrame(i), DT).caught) gapCaught++;
    expect(gapCaught).toBe(0); // no «т» at strict = no win (escape hatch is the slider)
  });

  it("AC#1 (#18): on a stop scene a pause NEVER wins — even at EASY; only a «т» does", () => {
    // Two-phase win (#18): the run-out-of-breath gap is dropped on a stop scene at
    // EVERY slider position — a pure pause parks at the checkpoint forever. The «т»
    // burst is the only finish (an EARLIER win, not a bonus on top of a gap).
    const gapM = new PatternMatcher(STOP_PATTERN, { assist: 1, rung3: true });
    feed(gapM, 45, HOLD);
    let gapCaught = 0;
    let burstSeen = false;
    for (let i = 0; i < 60; i++) {
      const r = gapM.update(gapFrame(i), DT); // a long silence, no «т»
      if (r.caught) gapCaught++;
      if (r.burstDetected) burstSeen = true;
    }
    expect(gapCaught).toBe(0); // the pause never wins, at easy or anywhere
    expect(burstSeen).toBe(false); // and no phantom burst fired on plain silence

    const burstM = new PatternMatcher(STOP_PATTERN, { assist: 1, rung3: true });
    feed(burstM, 45, HOLD);
    const r = burstM.update(makeFrame(BURST), DT);
    expect(r.burstDetected).toBe(true);
    expect(r.caught).toBe(true); // the «т» burst is the finish at easy too
  });

  it("AC#1 (#18): the default assist (0.5) also requires the «т» — a pause never wins", () => {
    // rung3 now ships ON by default; the default slider no longer has a pause-win.
    // A pure pause parks forever; a «т» finishes. The gentler path is a LOOSER «т»
    // (burstOptsForAssist), not the retired breath-stop.
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0.5, rung3: true });
    feed(m, 45, HOLD);
    let gapCaught = 0;
    for (let i = 0; i < 30; i++) if (m.update(gapFrame(i), DT).caught) gapCaught++;
    expect(gapCaught).toBe(0); // no «т» = no win, even at the default

    const burstM = new PatternMatcher(STOP_PATTERN, { assist: 0.5, rung3: true });
    feed(burstM, 45, HOLD);
    expect(burstM.update(makeFrame(BURST), DT).caught).toBe(true);
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
    expect(caughtEver).toBe(false); // but with no closure/burst it never catches
    expect(last.consonantClass).toBe("sonorant"); // and it's labelled a hum
  });

  it("labels the release: a hold reads 'sonorant', a hold+closure reads 'stop'", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    const held = feed(m, 45, HOLD);
    expect(held.consonantClass).toBe("sonorant"); // sustained voiced, no gap yet
    let last = held;
    for (let i = 0; i < 10; i++) {
      last = m.update(gapFrame(i), DT);
    }
    expect(last.consonantClass).toBe("stop"); // the closure makes it a stop
  });

  it("a 'wrong' consonant class never blocks the «т» catch (graded, never gated)", () => {
    // Even if the hold tail were hiss-y (the classifier might say 'fricative'), the
    // «т» burst still catches — the class label gates nothing (#18: the finish is
    // now the burst, not the retired gap).
    const m = new PatternMatcher(STOP_PATTERN, { assist: 1, rung3: true });
    feed(m, 45, { voiced: true, level: 0.8, vowelLikeness: 0.85, zcr: 0.4 });
    expect(m.update(makeFrame(BURST), DT).caught).toBe(true);
  });

  it("rung3 ON but a non-stop ('any') scene: stopBurst ignored, gap ALWAYS wins", () => {
    // PATTERN.release.want is undefined → "any", so `rung3Stop` is false: the burst
    // path stays off AND the gap is never withdrawn (we don't demand a burst a word
    // lacks), even at assist 0. Guards the `want === "stop"` half of the gate.
    const m = new PatternMatcher(PATTERN, { assist: 0, rung3: true });
    feed(m, 45, HOLD);
    const r = m.update(makeFrame(BURST), DT);
    expect(r.burstDetected).toBe(false); // no burst path on an "any" scene
    expect(r.consonantClass).not.toBe("none"); // but rung3 still labels the window
    // The plain gap still finishes the catch, strict assist and all.
    let caught = 0;
    for (let i = 0; i < 12; i++) if (m.update(gapFrame(i), DT).caught) caught++;
    expect(caught).toBe(1);
  });

  it("the burst-catch is edge-triggered exactly once (done latches)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(m, 45, HOLD);
    let caught = 0;
    for (let i = 0; i < 6; i++) {
      // every frame carries stopBurst; the catch must fire only once.
      const r = m.update(makeFrame(BURST), DT);
      if (r.caught) caught++;
    }
    expect(caught).toBe(1);
  });

  it("reset() clears the hold + release window between rounds", () => {
    // GameView.reset() calls matcher.reset() each round; a stale hold or `recent`
    // window must not leak a spurious catch into the next round.
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(m, 45, HOLD);
    m.reset();
    const r = m.update(makeFrame(BURST), DT);
    expect(r.consonantClass).toBe("none"); // window emptied (1 frame < minVoiced)
    expect(r.caught).toBe(false); // hold reset → a burst has nothing to complete
  });
});

// --- #18: the two-phase «т» win (arm → checkpoint → «т» only) ----------------

// A pause-tolerant armed «т»: after a long pause the engine's fast `stopBurst`
// can't fire (the arming vowel is gone from its ~0.3 s window), so the child's «т»
// arrives as a fresh NON-vowel-like onset instead. And a vowel RE-onset that must
// NOT win (AC#4): loud, onset, but tonal (low zcr, high vowelLikeness).
const T_REONSET = { voiced: true, onset: true, vowelLikeness: 0.08, zcr: 0.45, silenceMs: 0 };
const VOWEL_REONSET = { voiced: true, onset: true, vowelLikeness: 0.85, zcr: 0.03, silenceMs: 0 };

describe("PatternMatcher — two-phase «т» win (#18)", () => {
  it("AC#3: arm → ≥3 s of silence → a «т» still completes (pause-tolerant)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    expect(feed(m, 45, HOLD).holdSatisfied).toBe(true); // armed at the checkpoint
    // ~3.2 s of pure silence: parks, never wins.
    let caughtDuringSilence = 0;
    for (let i = 0; i < 200; i++) if (m.update(gapFrame(i), DT).caught) caughtDuringSilence++;
    expect(caughtDuringSilence).toBe(0);
    // Now the «т» arrives as a fresh non-vowel-like onset (no stopBurst — the vowel
    // is long gone from the fast-env window). It STILL completes the round.
    const r = m.update(makeFrame(T_REONSET), DT);
    expect(r.burstDetected).toBe(true);
    expect(r.caught).toBe(true);
  });

  it("AC#4: arm → silence → re-starting the VOWEL does NOT complete (no false-fire)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    feed(m, 45, HOLD);
    feed(m, 20, { voiced: false, silenceMs: 320 }); // a pause since the arm
    // Re-onset of a clean vowel: an onset, but tonal — the guard rejects it.
    let caughtEver = false;
    if (m.update(makeFrame(VOWEL_REONSET), DT).caught) caughtEver = true;
    for (let i = 0; i < 40; i++) {
      if (m.update(makeFrame({ ...VOWEL_REONSET, onset: false }), DT).caught) caughtEver = true;
    }
    expect(caughtEver).toBe(false); // the vowel re-onset never wins — only a «т»
  });

  it("AC#5: a «т» BEFORE the hold is satisfied never completes the round", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    const held = feed(m, 20, HOLD); // ~320 ms < the 600 ms min → not yet armed
    expect(held.holdSatisfied).toBe(false);
    const r = m.update(makeFrame(BURST), DT); // a real «т», but too early
    expect(r.caught).toBe(false);
    expect(r.burstDetected).toBe(false); // gated on the arm
  });

  it("AC#2: a real «т» burst completes at EVERY slider position", () => {
    for (const assist of [0, 0.3, 0.5, 0.7, 1]) {
      const m = new PatternMatcher(STOP_PATTERN, { assist, rung3: true });
      feed(m, 45, HOLD);
      expect(m.update(makeFrame(BURST), DT).caught).toBe(true);
    }
  });

  it("armedForBurst flags the parked checkpoint only on a rung3 stop scene", () => {
    // A stop scene, rung3 on: armedForBurst latches with the hold.
    const stop = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    expect(stop.update(makeFrame(HOLD), DT).armedForBurst).toBe(false); // not held yet
    expect(feed(stop, 45, HOLD).armedForBurst).toBe(true); // parked, waiting for «т»
    // A non-stop scene never arms-for-burst (the gap still finishes it).
    const anyScene = new PatternMatcher(PATTERN, { assist: 0, rung3: true });
    expect(feed(anyScene, 45, HOLD).armedForBurst).toBe(false);
    // rung3 off: no two-phase, so never armed-for-burst either.
    const off = new PatternMatcher(STOP_PATTERN, { assist: 0 });
    expect(feed(off, 45, HOLD).armedForBurst).toBe(false);
  });

  it("requiresBurst is true only for a rung3 stop scene", () => {
    expect(new PatternMatcher(STOP_PATTERN, { rung3: true }).requiresBurst).toBe(true);
    expect(new PatternMatcher(STOP_PATTERN, { rung3: false }).requiresBurst).toBe(false);
    expect(new PatternMatcher(PATTERN, { rung3: true }).requiresBurst).toBe(false);
  });

  it("forceHoldSatisfied() latches the checkpoint so the next «т» wins (debug jump)", () => {
    const m = new PatternMatcher(STOP_PATTERN, { assist: 0, rung3: true });
    m.forceHoldSatisfied(); // no vowel drilled at all
    const armed = m.update(makeFrame({ voiced: false, silenceMs: 16 }), DT);
    expect(armed.holdSatisfied).toBe(true);
    expect(armed.armedForBurst).toBe(true);
    expect(m.update(makeFrame(BURST), DT).caught).toBe(true); // the next «т» wins
  });
});

// --- #18: the armedBurst predicate is pure and correctly guarded -------------

describe("armedBurst predicate (#18)", () => {
  const f = (p: Partial<Parameters<typeof makeFrame>[0]>) => makeFrame(p);

  it("a real stopBurst always fires — even before any silence elapsed", () => {
    expect(armedBurst(f({ stopBurst: true }), false)).toBe(true);
    expect(armedBurst(f({ stopBurst: true }), true)).toBe(true);
  });

  it("a fresh non-vowel-like onset AFTER a silence fires (pause-tolerant «т»)", () => {
    expect(armedBurst(f({ onset: true, zcr: ZCR_HIGH + 0.1, vowelLikeness: 0.9 }), true)).toBe(true);
    expect(armedBurst(f({ onset: true, vowelLikeness: 0, zcr: 0 }), true)).toBe(true); // low vowelLikeness alone
  });

  it("a VOWEL re-onset after a silence does NOT fire (the AC#4 guard)", () => {
    // Onset + past silence, but tonal (low zcr, high vowelLikeness) → rejected.
    const vowelish = f({ onset: true, vowelLikeness: ARMED_BURST_VOWEL_FLOOR + 0.1, zcr: 0.02 });
    expect(armedBurst(vowelish, true)).toBe(false);
  });

  it("no fire without a preceding silence, or without an onset", () => {
    const t = { onset: true, zcr: ZCR_HIGH + 0.1, vowelLikeness: 0.9 };
    expect(armedBurst(f(t), false)).toBe(false); // no silence since arm
    expect(armedBurst(f({ ...t, onset: false }), true)).toBe(false); // not a fresh onset
  });
});
