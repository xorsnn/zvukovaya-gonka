import { PatternMatcher } from "./PatternMatcher";
import { anyRungOn, type PhoneticConfig } from "./config";
import type { WordScene } from "./types";
import type { VowelBaseline } from "../audio/PhoneticFeatures";

/**
 * Build the round's phonetic matcher for a scene — or `null` for the
 * loudness-only path (the kill-switch, when no rung is enabled).
 *
 * This is the ONE decision that both `main.ts`'s per-round `buildMatcher()` and
 * the scene picker share: a round's matcher is built from the ACTIVE scene's
 * `pattern`. Factoring it out (pure, no DOM) makes the picker's promise —
 * "choosing a scene rebuilds the matcher on THAT scene's pattern" (#16, AC#1) —
 * verifiable without a canvas, and keeps the two acoustic modes (chase/pull)
 * provably sharing the identical stack: кот and вот carry the same `pattern`, so
 * they yield an identical matcher (AC#3, no new tuning).
 */
export function buildSceneMatcher(
  scene: WordScene,
  config: PhoneticConfig,
  opts: { holdThreshold: number; vowelBaseline: VowelBaseline | null },
): PatternMatcher | null {
  if (!anyRungOn(config)) return null;
  return new PatternMatcher(scene.pattern, {
    assist: config.assist,
    holdThreshold: opts.holdThreshold,
    rung1: config.rung1,
    rung2: config.rung2,
    rung3: config.rung3,
    vowelBaseline: opts.vowelBaseline,
  });
}
