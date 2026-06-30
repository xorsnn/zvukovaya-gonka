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
 */
function holdStop(vowel: Vowel): AcousticPattern {
  return {
    rung: 1,
    sustain: { minMs: 600, want: "vowel" },
    release: { requireGapMs: 120 },
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
    pattern: holdStop("о"),
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
    pattern: holdStop("и"),
  },
];

export const DEFAULT_WORD = WORDS[0];
