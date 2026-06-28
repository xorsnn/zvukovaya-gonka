import type { WordScene } from "./types";

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
  },
];

export const DEFAULT_WORD = WORDS[0];
