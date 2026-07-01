import { describe, it, expect } from "vitest";
import { WORDS, DEFAULT_WORD, PICKABLE_SCENES } from "../src/game/words";
import { carrotDepth } from "../src/game/GameView";
import { buildSceneMatcher } from "../src/game/round";
import { DEFAULT_CONFIG, type PhoneticConfig } from "../src/game/config";
import type { WordScene } from "../src/game/types";

// --- The «Морковка» pull scene is well-formed (#16, AC#5) --------------------

describe("вот (pull scene) is well-formed", () => {
  const vot = WORDS.find((w) => w.id === "vot") as WordScene;
  const kot = WORDS.find((w) => w.id === "kot") as WordScene;

  it("exists and is a pull scene with the rabbit/carrot actors", () => {
    expect(vot).toBeDefined();
    expect(vot.type).toBe("pull");
    expect(vot.word).toBe("вот");
    expect(vot.chaser).toBe("🐰"); // the puller
    expect(vot.fleer).toBe("🥕"); // the prize
    expect(vot.burstPart).toBe("Т"); // pops on «…Т»
  });

  it("reuses кот's acoustic pattern verbatim — zero new tuning (AC#3)", () => {
    // Same hold, same «т» stop, same target vowel: the DSP/matching is untouched.
    expect(vot.pattern).toEqual(kot.pattern);
    expect(vot.pattern.rung).toBe(1);
    expect(vot.pattern.sustain.want).toBe("vowel");
    expect(vot.pattern.release.want).toBe("stop");
    expect(vot.pattern.release.letter).toBe("Т");
    expect(vot.pattern.vowel).toBe("о");
  });
});

// --- The start-screen picker (#16, AC#1 + AC#5) ------------------------------

describe("scene picker", () => {
  it("offers exactly the two modes, chase (default) first", () => {
    expect(PICKABLE_SCENES).toHaveLength(2);
    expect(PICKABLE_SCENES[0].type).toBe("chase");
    expect(PICKABLE_SCENES[1].type).toBe("pull");
    // The default (first) is the chase — choosing nothing reproduces today's flow.
    expect(PICKABLE_SCENES[0]).toBe(DEFAULT_WORD);
  });

  it("choosing a scene rebuilds the matcher on THAT scene's pattern", () => {
    // main.ts's buildMatcher() and the picker share buildSceneMatcher(); a round's
    // matcher is built from the ACTIVE scene's pattern, so the picker's selection
    // is what drives the round.
    const opts = { holdThreshold: 0.5, vowelBaseline: null };
    for (const scene of PICKABLE_SCENES) {
      const m = buildSceneMatcher(scene, DEFAULT_CONFIG, opts);
      expect(m).not.toBeNull();
      expect(m!.pattern).toBe(scene.pattern);
    }
  });

  it("the two modes yield equivalent matchers (shared acoustic stack, AC#3)", () => {
    const opts = { holdThreshold: 0.5, vowelBaseline: null };
    const chase = buildSceneMatcher(PICKABLE_SCENES[0], DEFAULT_CONFIG, opts);
    const pull = buildSceneMatcher(PICKABLE_SCENES[1], DEFAULT_CONFIG, opts);
    expect(pull!.pattern).toEqual(chase!.pattern);
  });

  it("the kill-switch config yields the loudness path (null) for either mode (AC#5)", () => {
    const allOff: PhoneticConfig = {
      rung1: false,
      rung2: false,
      rung3: false,
      assist: 0.5,
      debug: false,
    };
    for (const scene of PICKABLE_SCENES) {
      expect(
        buildSceneMatcher(scene, allOff, { holdThreshold: 0.5, vowelBaseline: null }),
      ).toBeNull();
    }
  });
});

// --- carrotDepth is a pure, monotonic emergence curve (#16, AC#5) ------------

describe("carrotDepth(progress)", () => {
  it("is anchored at 0 (buried) and 1 (free), and stays in [0,1]", () => {
    expect(carrotDepth(0)).toBe(0);
    expect(carrotDepth(1)).toBe(1);
    for (let p = -0.5; p <= 1.5; p += 0.1) {
      const d = carrotDepth(p);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it("is strictly monotonic in progress — more progress always shows more carrot", () => {
    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const d = carrotDepth(Math.min(1, p));
      if (p > 0 && p <= 1) expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it("clamps out-of-range progress (no overshoot below 0 or above 1)", () => {
    expect(carrotDepth(-3)).toBe(0);
    expect(carrotDepth(9)).toBe(1);
  });
});
