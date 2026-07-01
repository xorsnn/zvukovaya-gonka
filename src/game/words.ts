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
 * Word bank. Each entry is a [hold] + [stop] word that reskins the same acoustic
 * mechanic; `type` picks the *picture* (a chase or a pull, #16) — see
 * {@link WordScene} and root CLAUDE.md. Adding a `[hold]+[stop]` word on an
 * existing type is data-only; a new `type` also needs a GameView render branch.
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
  {
    // «Морковка» (#16): the SAME acoustic word as кот — hold «во-о-о», pop on «…Т»
    // (= "вот!", there it is) — rendered as a PULL instead of a chase. Reuses
    // кот's exact holdStop("о","stop","Т"): zero new acoustic tuning. Here the two
    // actor emoji read as puller/prize (rabbit/carrot), not pursuer/fleer.
    id: "vot",
    type: "pull",
    word: "вот",
    display: "ВО-О-О-Т",
    sustainPart: "ВОоо",
    burstPart: "Т",
    hint: "Тяни «во-о-о», а потом — «Т»!",
    chaser: "🐰", // the puller
    fleer: "🥕", // the prize
    theme: "meadow",
    pattern: holdStop("о", "stop", "Т"), // identical to «кот» — the «т» pops the carrot
  },
  // --- ready for later (not surfaced in the picker yet) ---
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

export const DEFAULT_WORD = WORDS[0]; // кот (chase) — the picker's default

/**
 * The play modes surfaced in the start-screen scene picker (issue #16), in
 * display order — the DEFAULT (chase) first, so choosing nothing reproduces the
 * pre-#16 flow. Both share the identical «т»/hold acoustic pattern; they differ
 * only in `type` (the render branch). дом/кит stay unsurfaced (extra chase words,
 * not extra modes).
 */
export const PICKABLE_SCENES: WordScene[] = [
  WORDS.find((w) => w.id === "kot")!,
  WORDS.find((w) => w.id === "vot")!,
];
