/**
 * A WordScene is the content unit of the game. The MVP ships one (`кот`), but
 * the chase mechanic is fully generic: any word shaped like
 *   [sustainable vowel/sonorant] + [final stop]
 * reskins into a chase by swapping the two emoji and the on-screen text.
 *
 * Add a scene = add a data object. No new code required for more chase words.
 */
export type SceneType = "chase";

export interface WordScene {
  id: string;
  type: SceneType;

  /** The whole target word, e.g. "кот". */
  word: string;

  /** Big spoken-out display, e.g. "КО-О-О-Т". Shown to the caregiver/child. */
  display: string;

  /** The held part the child sustains, e.g. "КОоо". Highlighted during chase. */
  sustainPart: string;

  /** The final burst, e.g. "Т". Highlighted at the pounce. */
  burstPart: string;

  /** Short instruction for the caregiver, e.g. "Тяни звук, потом — Т!". */
  hint: string;

  // --- chase reskin ---
  /** The pursuer emoji (e.g. cat). */
  chaser: string;
  /** The one who flees (e.g. mouse). */
  fleer: string;
  /** Background theme key. */
  theme: "meadow";
}
