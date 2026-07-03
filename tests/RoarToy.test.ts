import { describe, it, expect } from "vitest";
import {
  initRoar,
  stepRoar,
  effectiveThreshold,
  DEFAULT_ROAR_CFG,
  type RoarStateT,
  type RoarToyCfg,
} from "../src/game/RoarToy";

// The pure dino-toy state machine (issue #30). It reads ONLY `level`; these tests
// drive canned level sequences at a fixed dt and assert the roar cadence, the
// lockout, the assist mapping, and the intensity — no DOM, no clock, no mic.

const CFG = DEFAULT_ROAR_CFG; // triggerLevel 0.12, pause 300, minVoice 150, lockout 1200, assistK 0.7

/** A frame of the given level, in ms of duration (default 16 ms ≈ 60 fps). */
interface F {
  level: number;
  dt?: number;
}

/**
 * Run a level sequence through stepRoar from a fresh (or given) state, collecting
 * every roar with the intensity + frame index it fired on.
 */
function run(
  seq: F[],
  assist = 0.5,
  cfg: RoarToyCfg = CFG,
  start: RoarStateT = initRoar(),
): { state: RoarStateT; roars: { intensity: number; at: number }[] } {
  let state = start;
  const roars: { intensity: number; at: number }[] = [];
  seq.forEach((f, i) => {
    const r = stepRoar(state, f.level, f.dt ?? 16, assist, cfg);
    state = r.state;
    if (r.roar) roars.push({ intensity: r.intensity, at: i });
  });
  return { state, roars };
}

/** N frames of one level. */
function hold(level: number, n: number, dt = 16): F[] {
  return Array.from({ length: n }, () => ({ level, dt }));
}

const LOUD = 0.6; // comfortably above the effective threshold at assist 0.5
const QUIET = 0; // silence

describe("effectiveThreshold", () => {
  it("is the base level at assist 0 and falls as assist rises (легче)", () => {
    expect(effectiveThreshold(CFG, 0)).toBeCloseTo(0.12, 6);
    // 0.12 * (1 - 1*0.7) = 0.036
    expect(effectiveThreshold(CFG, 1)).toBeCloseTo(0.036, 6);
    expect(effectiveThreshold(CFG, 1)).toBeLessThan(effectiveThreshold(CFG, 0));
  });
  it("clamps assist to 0..1", () => {
    expect(effectiveThreshold(CFG, -5)).toBeCloseTo(0.12, 6);
    expect(effectiveThreshold(CFG, 5)).toBeCloseTo(0.036, 6);
  });
});

describe("stepRoar — one roar per voice→pause cycle (AC#2)", () => {
  it("fires exactly one roar after a real voicing followed by a full pause", () => {
    const seq = [...hold(LOUD, 15), ...hold(QUIET, 25)]; // 240 ms voice, 400 ms pause
    const { roars } = run(seq);
    expect(roars).toHaveLength(1);
  });

  it("fires on the frame the pause first reaches pauseMs, not before", () => {
    // 240 ms voicing, then quiet. pauseMs=300 → the 300/16≈19th quiet frame fires.
    const voice = hold(LOUD, 15);
    const quiet = hold(QUIET, 30);
    const { roars } = run([...voice, ...quiet]);
    expect(roars).toHaveLength(1);
    const firstQuietIndex = voice.length; // 15
    // ceil(300/16)=19 quiet frames of accumulation; roar at the 19th quiet frame.
    expect(roars[0].at).toBe(firstQuietIndex + 19 - 1);
  });

  it("N voice→pause cycles produce exactly N roars", () => {
    // Each pause (1600 ms quiet) is long enough for the roar to fire AND the
    // 1200 ms lockout to fully expire before the next voicing begins.
    const cycle = [...hold(LOUD, 15), ...hold(QUIET, 100)];
    const { roars } = run([...cycle, ...cycle, ...cycle]);
    expect(roars).toHaveLength(3);
  });
});

describe("stepRoar — never-fire guards", () => {
  it("pure silence never roars (AC#3)", () => {
    const { roars, state } = run(hold(QUIET, 200));
    expect(roars).toHaveLength(0);
    expect(state.phase).toBe("listening");
  });

  it("a below-threshold hum never roars, then quiet, never roars (AC#3)", () => {
    // level 0.05 < effThreshold(0.12) at assist 0.5 → never counts as voicing.
    const { roars } = run([...hold(0.05, 40), ...hold(QUIET, 40)], 0.5);
    expect(roars).toHaveLength(0);
  });

  it("a blip shorter than minVoiceMs never roars (AC#4)", () => {
    // minVoiceMs=150; 8 frames*16=128 ms < 150 → discarded on the pause.
    const { roars, state } = run([...hold(LOUD, 8), ...hold(QUIET, 40)]);
    expect(roars).toHaveLength(0);
    expect(state.phase).toBe("listening"); // blip discarded, back to listening
  });

  it("a brief mid-utterance dip (< pauseMs) does not reset progress", () => {
    // 128 ms voice, a 96 ms dip (< 300 ms pause), then more voice, then a full
    // pause. Cumulative voice ≥ minVoiceMs → one roar despite the dip.
    const seq = [
      ...hold(LOUD, 8), // 128 ms
      ...hold(QUIET, 6), // 96 ms dip, under the 300 ms pause
      ...hold(LOUD, 8), // 128 ms more → cumulative 256 ms voiced
      ...hold(QUIET, 25), // 400 ms pause → fire
    ];
    const { roars } = run(seq);
    expect(roars).toHaveLength(1);
  });
});

describe("stepRoar — lockout suppression (AC#5, AC#9)", () => {
  it("ignores loud input during the roaring lockout — no second roar", () => {
    // voice→pause→roar, then keep shouting through the whole lockout window.
    const seq = [...hold(LOUD, 15), ...hold(QUIET, 25), ...hold(LOUD, 60)]; // 960 ms loud < 1200 lockout
    const { roars, state } = run(seq);
    expect(roars).toHaveLength(1);
    expect(state.phase).toBe("roaring"); // still locked out at the end
  });

  it("resumes listening after the lockout, and a fresh cycle roars again", () => {
    const seq = [
      ...hold(LOUD, 15),
      ...hold(QUIET, 25), // roar #1
      ...hold(QUIET, 80), // 1280 ms quiet — lets the 1200 ms lockout expire
      ...hold(LOUD, 15),
      ...hold(QUIET, 25), // roar #2
    ];
    const { roars } = run(seq);
    expect(roars).toHaveLength(2);
  });

  it("the roar frame arms the full lockout, and it counts down by dt after", () => {
    let s = initRoar();
    // Drive up to (and including) the roar frame: 240 ms voice, then quiet frames
    // until the pause fires. The roar frame sets lockout to exactly CFG.lockoutMs.
    for (const f of hold(LOUD, 15)) s = stepRoar(s, f.level, 16, 0.5, CFG).state;
    let fired = false;
    while (!fired) {
      const r = stepRoar(s, QUIET, 16, 0.5, CFG);
      s = r.state;
      fired = r.roar;
    }
    expect(s.phase).toBe("roaring");
    expect(s.lockoutMs).toBeCloseTo(CFG.lockoutMs, 6);
    // A loud frame mid-lockout is ignored; the lockout just ticks down by dt.
    const r = stepRoar(s, LOUD, 100, 0.5, CFG);
    expect(r.roar).toBe(false);
    expect(r.state.phase).toBe("roaring");
    expect(r.state.lockoutMs).toBeCloseTo(CFG.lockoutMs - 100, 6);
  });
});

describe("stepRoar — assist lowers the threshold (AC#6)", () => {
  it("a level below the strict threshold does not roar at assist 0 but does at assist 1", () => {
    // level 0.08: at assist 0 thr=0.12 (below → silent); at assist 1 thr=0.036 (above).
    const seq = [...hold(0.08, 20), ...hold(QUIET, 30)];
    expect(run(seq, 0).roars).toHaveLength(0);
    expect(run(seq, 1).roars).toHaveLength(1);
  });
});

describe("stepRoar — intensity tracks the utterance peak (AC#7)", () => {
  it("a louder utterance produces a larger roar intensity", () => {
    const soft = run([...hold(0.35, 20), ...hold(QUIET, 30)]).roars[0];
    const loud = run([...hold(0.9, 20), ...hold(QUIET, 30)]).roars[0];
    expect(soft.intensity).toBeCloseTo(0.35, 6);
    expect(loud.intensity).toBeCloseTo(0.9, 6);
    expect(loud.intensity).toBeGreaterThan(soft.intensity);
  });

  it("intensity is the running MAX across the utterance, not the last frame", () => {
    // ramp up to 0.8 then down to 0.3 before the pause → peak 0.8.
    const seq = [
      ...hold(0.4, 6),
      ...hold(0.8, 6),
      ...hold(0.3, 6),
      ...hold(QUIET, 30),
    ];
    expect(run(seq).roars[0].intensity).toBeCloseTo(0.8, 6);
  });

  it("clamps intensity to 0..1 for an over-unit level", () => {
    const seq = [...hold(1.7, 20), ...hold(QUIET, 30)];
    expect(run(seq).roars[0].intensity).toBeCloseTo(1, 6);
  });
});

describe("stepRoar — integration: an assist sweep changes the roar count", () => {
  it("a borderline babble roars more often as the toy is made легче", () => {
    // 0.09 sits between the strict (0.12) and lenient (0.036) thresholds.
    const cycle = [...hold(0.09, 20), ...hold(QUIET, 100)]; // pause clears the lockout
    const three = [...cycle, ...cycle, ...cycle];
    expect(run(three, 0).roars).toHaveLength(0); // строго: never counts as voicing
    expect(run(three, 1).roars).toHaveLength(3); // легче: every babble roars
  });
});
