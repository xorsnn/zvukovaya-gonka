import { describe, it, expect } from "vitest";
import {
  LetterIndicator,
  LEVEL_GATE,
  SCORE_MIN,
} from "../src/game/LetterIndicator";
import { VOWEL_FORMANTS, type Vowel } from "../src/audio/PhoneticFeatures";

// She calibrated holding «а» (high, child-ish formants); that anchors her space.
const baseA = { centroid: 1100, f1: 850, f2: 1400 };

/** The (F1, F2) where target vowel `v` sits in HER space: the canonical map
 * scaled by her-«а» ÷ reference-«а» — exactly where `vowelMatch`/`classifyVowel`
 * expect it, so a frame placed here scores ~1 for `v` (its argmax centre). */
function scaledCentre(v: Vowel): { f1: number; f2: number } {
  const refA = VOWEL_FORMANTS["а"];
  const refT = VOWEL_FORMANTS[v];
  return {
    f1: baseA.f1 * (refT.f1 / refA.f1),
    f2: baseA.f2 * (refT.f2 / refA.f2),
  };
}

/** Feed the same frame `n` times at 16 ms dt; return the last verdict. */
function hold(
  li: LetterIndicator,
  f: { f1: number; f2: number },
  n: number,
  { level = 0.6, voiced = true, baseline = baseA as typeof baseA | null } = {},
) {
  let last = li.update(f, level, voiced, baseline, 16);
  for (let i = 1; i < n; i++) last = li.update(f, level, voiced, baseline, 16);
  return last;
}

describe("LetterIndicator (smoother + gate, #13)", () => {
  it("AC#3: converges to «о» on a steady «о» stream within ~8 frames", () => {
    const li = new LetterIndicator();
    const o = scaledCentre("о");
    // Early on the smoothed winner hasn't cleared SCORE_MIN yet → «—».
    expect(hold(li, o, 5).vowel).toBeNull();
    // By ~8 frames (~120 ms, one half-life) it has settled on «о».
    expect(hold(li, o, 3).vowel).toBe("о");
  });

  it("AC#3: a single ambiguous frame does not flip the settled letter", () => {
    const li = new LetterIndicator();
    hold(li, scaledCentre("о"), 20); // settle firmly on «о»
    // One stray «и» frame: the EMA barely moves, so the glyph stays «о».
    const flick = li.update(scaledCentre("и"), 0.6, true, baseA, 16);
    expect(flick.vowel).toBe("о");
  });

  it("AC#4: shows «—» when level ≤ LEVEL_GATE (input gated to silence)", () => {
    const li = new LetterIndicator();
    // Right at the gate the input is treated as silence, so nothing accumulates.
    const out = hold(li, scaledCentre("о"), 20, { level: LEVEL_GATE });
    expect(out.vowel).toBeNull();
    expect(out.confidence).toBe(0);
  });

  it("AC#4: shows «—» when not voiced", () => {
    const li = new LetterIndicator();
    const out = hold(li, scaledCentre("о"), 20, { voiced: false });
    expect(out.vowel).toBeNull();
  });

  it("AC#4: shows «—» on a near-tie (margin < MARGIN_MIN) despite a strong match", () => {
    const li = new LetterIndicator();
    const cO = scaledCentre("о");
    // Geometric midpoint between «а» (the baseline itself) and «о»: both vowels
    // match ~equally, so the winner never clears the runner-up by MARGIN_MIN.
    const mid = { f1: Math.sqrt(cO.f1 * baseA.f1), f2: Math.sqrt(cO.f2 * baseA.f2) };
    const out = hold(li, mid, 40);
    expect(out.vowel).toBeNull(); // ambiguous → «—», not a coin-flip glyph
    expect(out.confidence).toBeGreaterThan(SCORE_MIN); // ...but it WAS a strong match
  });

  it("AC#4: shows «—» with no baseline (classifyVowel has no opinion)", () => {
    const li = new LetterIndicator();
    const out = hold(li, { f1: 600, f2: 1200 }, 20, { baseline: null });
    expect(out.vowel).toBeNull();
    expect(out.confidence).toBe(0);
  });

  it("reset() clears the smoothed state between rounds", () => {
    const li = new LetterIndicator();
    hold(li, scaledCentre("о"), 20); // settle on «о»
    li.reset();
    // After reset the first frame starts from zero again → not yet settled.
    expect(li.update(scaledCentre("о"), 0.6, true, baseA, 16).vowel).toBeNull();
  });
});
