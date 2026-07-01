import type { AcousticPattern, WordScene } from "./types";
import type { Vowel } from "../audio/PhoneticFeatures";

/**
 * Rung-1 shape shared by the current кот/дом/кит words: hold a vowel-like sound
 * for ~600 ms, then stop. The matcher grades the hold by vowelLikeness and only
 * arms the pounce after a real sustained vowel + a genuine stop gap — which is
 * what stops the "continuous scream" and "single shout" cheats.
 *
 * `vowel` tags the nucleus for Rung 2 (#5). It is purely additive: with rung2
 * off the pattern behaves exactly as the shipped Rung-1 shape; with rung2 on it
 * only *grades* speed toward that vowel, never gating the hold or the catch.
 *
 * `want` tags the final action for Rung 3 (#6): «т»-final words ask for a genuine
 * `"stop"` (a closure, optionally a burst); the default `"any"` is today's
 * "any near-silence gap" finale. Also additive: with rung3 off the release is
 * exactly the Rung-1 gap, and even with it on a "stop" only *adds* an earlier
 * burst-catch — running out of breath still finishes the catch.
 */
function holdStop(
  vowel: Vowel,
  want: "stop" | "any" = "any",
  letter?: string,
): AcousticPattern {
  return {
    rung: 1,
    sustain: { minMs: 600, want: "vowel" },
    release: { requireGapMs: 120, want, ...(letter ? { letter } : {}) },
    vowel,
  };
}

/**
 * Word bank. The MVP focuses on «кот», but the structure is ready for the
 * difficulty ladder described in the brief: each entry is a [hold] + [stop]
 * word that reskins the same chase mechanic. Onomatopoeia / non-chase scenes
 * would add a new SceneType later.
 */
export const WORDS: WordScene[] = [
  {
    id: "kot",
    type: "chase",
    word: "кот",
    display: "КО-О-О-Т",
    sustainPart: "КОоо",
    burstPart: "Т",
    hint: "Тяни «ко-о-о», а потом — «Т»!",
    chaser: "🐱",
    fleer: "🐭",
    theme: "meadow",
    pattern: holdStop("о", "stop", "Т"), // «кот» finishes on a real «т» stop (Rung 3)
  },
  // --- ready for later (not surfaced in the MVP flow yet) ---
  {
    id: "dom",
    type: "chase",
    word: "дом",
    display: "ДО-О-О-М",
    sustainPart: "ДОоо",
    burstPart: "М",
    hint: "Тяни «до-о-о», а потом — «М»!",
    chaser: "🐶",
    fleer: "🦴",
    theme: "meadow",
    pattern: holdStop("о"),
  },
  {
    id: "kit",
    type: "chase",
    word: "кит",
    display: "КИ-И-И-Т",
    sustainPart: "КИии",
    burstPart: "Т",
    hint: "Тяни «ки-и-и», а потом — «Т»!",
    chaser: "🐳",
    fleer: "🐟",
    theme: "meadow",
    pattern: holdStop("и", "stop", "Т"), // «кит» also ends on a «т» stop (Rung 3)
  },
];

export const DEFAULT_WORD = WORDS[0];
